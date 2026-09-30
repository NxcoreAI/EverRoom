import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath, relative } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  RequestError,
  ndJsonStream,
  type Agent,
  type Client,
  type InitializeResponse,
  type McpServer,
} from "@zed-industries/agent-client-protocol";
import type { RuntimeCapabilities, AgentPermissionMode } from "@nxcore/agent-contract";
import type { SessionModeState } from "@zed-industries/agent-client-protocol";
import {
  AsyncEventQueue,
  type AgentRuntime,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from "@nxcore/agent-runtime";
import { childEnvironment, delegationPrompt } from "./runtime-common.js";
import { permissionModeCoversToolKind, permissionModeIdForProvider, semanticForProviderModeId } from "../agent/permission-modes.js";
import {
  localAcpAdapterCommand,
  type LocalAcpAdapterSpawn,
  type LocalAcpProvider,
} from "@nxcore/agent-contract";

function acpSessionModeSnapshot(modes: SessionModeState): { currentModeId: string; availableModeIds: string[] } | null {
  if (!modes?.currentModeId || !Array.isArray(modes.availableModes)) return null;
  return {
    currentModeId: modes.currentModeId,
    availableModeIds: modes.availableModes.map((mode) => mode.id).filter((id) => typeof id === "string"),
  };
}

export type { LocalAcpProvider };

export type AcpPermissionDecision = "approved" | "approved_session" | "denied" | "cancelled";

export interface AcpPermissionApprovalRequest {
  approvalId: string;
  agentSessionId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  command: string;
  cwd?: string;
}

/** 渲染层审批卡片的工具输入摘要：优先常见语义键，回退截断 JSON。 */
function acpToolInputSummary(rawInput: unknown): string {
  const input = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : {};
  for (const key of ["command", "file_path", "filePath", "path", "url", "pattern", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value.slice(0, 300);
  }
  try {
    const serialized = JSON.stringify(input);
    return (serialized === "{}" ? "" : serialized).slice(0, 300);
  } catch {
    return "";
  }
}

/** 适配器 tool_call 增量合并态（AcpToolCallState）：渲染层 tool.* 事件的发射依据。 */
export interface AcpToolCallState {
  name: string;
  title?: string;
  args: Record<string, unknown>;
  argsKey: string;
  status: string;
  terminal: boolean;
}

export type AcpToolCallUpdate =
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind?: string | null;
      status?: string | null;
      rawInput?: Record<string, unknown> | null;
      rawOutput?: Record<string, unknown> | null;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      title?: string | null;
      kind?: string | null;
      status?: string | null;
      rawInput?: Record<string, unknown> | null;
      rawOutput?: Record<string, unknown> | null;
    };

/** ACP tool kind → 渲染层语义名：shell/edit/read 命中时间线的标签与命令摘要正则。 */
function acpToolEventName(kind: string | null | undefined): string {
  switch (kind) {
    case "execute": return "shell";
    case "edit": return "edit";
    case "read": return "read";
    case "fetch": return "web_fetch";
    case "search": return "search";
    case "think": return "think";
    case "create": return "create";
    case "delete": return "delete";
    case "move": return "move";
    default: return "tool";
  }
}

function argsKeyOf(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args) ?? "{}";
  } catch {
    return "{}";
  }
}

export interface AcpToolCallEmission {
  type: "tool.requested" | "tool.started" | "tool.updated" | "tool.completed" | "tool.failed";
  payload: Record<string, unknown>;
}

/**
 * tool_call / tool_call_update → 渲染层 tool.* 事件（渠道会话执行时间线的数据源）。
 * 纯函数：prior 缺省=首见；返回本批事件 + 合并后的状态。
 */
export function reduceAcpToolCallUpdate(
  prior: AcpToolCallState | undefined,
  update: AcpToolCallUpdate,
): { events: AcpToolCallEmission[]; next: AcpToolCallState } {
  const status = update.status
    ?? (update.sessionUpdate === "tool_call" ? "pending" : prior?.status ?? "in_progress");
  // tool_call_update 只带增量字段：title/kind/rawInput 沿用已见状态。
  const title = update.title ?? prior?.title;
  const name = prior?.name ?? acpToolEventName(update.kind);
  const args = update.rawInput && typeof update.rawInput === "object"
    ? update.rawInput
    : prior?.args ?? {};
  const argsKey = argsKeyOf(args);
  const base: Record<string, unknown> = { toolCallId: update.toolCallId, name, args };
  if (title) base.title = title;

  const events: AcpToolCallEmission[] = [];
  if (!prior) {
    events.push({ type: status === "pending" ? "tool.requested" : "tool.started", payload: base });
  } else if (status === "in_progress" && prior.status === "pending") {
    events.push({ type: "tool.started", payload: base });
  } else if (argsKey !== prior.argsKey && !prior.terminal) {
    events.push({ type: "tool.updated", payload: base });
  }

  const terminalType = status === "completed" ? "tool.completed" : status === "failed" ? "tool.failed" : null;
  if (terminalType && !prior?.terminal) {
    if (terminalType === "tool.completed") {
      const result = update.rawOutput && typeof update.rawOutput === "object" ? update.rawOutput : null;
      events.push({
        type: "tool.completed",
        payload: {
          toolCallId: update.toolCallId,
          name,
          ...(result ? { result } : title ? { result: title } : {}),
        },
      });
    } else {
      events.push({
        type: "tool.failed",
        payload: { toolCallId: update.toolCallId, name, message: title ?? "工具调用失败" },
      });
    }
  }

  return {
    events,
    next: { name, ...(title ? { title } : {}), args, argsKey, status, terminal: Boolean(terminalType) || prior?.terminal === true },
  };
}

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_READ_TEXT_FILE_BYTES = 2 * 1024 * 1024;

export interface AcpAdapterCommand {
  command: string;
  args: string[];
  fallbacks?: string[];
  env?: Record<string, string>;
}

/**
 * provider → ACP 适配器命令（映射与安装指引在 @nxcore/agent-contract 共享，
 * 桌面端安装向导用同一份）。优先级：EVERROOM_ACP_COMMAND_<PROVIDER> 整行覆盖 >
 * 桌面端随 target 下发的绝对路径 spawn（免 gateway 瘦 PATH 解析）> 默认 bare 名。
 */
export function acpAdapterCommand(
  provider: LocalAcpProvider,
  executablePath: string,
  spawnOverride?: LocalAcpAdapterSpawn | null,
): AcpAdapterCommand {
  const { command, args, fallbacks, env } = localAcpAdapterCommand(provider, executablePath, process.env, spawnOverride);
  const resolved: AcpAdapterCommand = { command, args };
  if (fallbacks?.length) resolved.fallbacks = fallbacks;
  if (env) resolved.env = env;
  return resolved;
}

interface ActiveAcpSession {
  queue: AsyncEventQueue<RuntimeEvent>;
  runId: string;
  agentSessionId: string;
  mutationAllowed: boolean;
  humanApproval: boolean;
  messageStarted: boolean;
  text: string;
  pendingApprovals: Set<string>;
  /** toolCallId → 合并态（渲染层 tool.* 事件发射依据）。 */
  toolCalls: Map<string, AcpToolCallState>;
  /** 适配器上报的模式状态（session/new·load 响应与 current_mode_update 维护）；null=适配器未声明 modes 能力。 */
  modes: { currentModeId: string; availableModeIds: string[] } | null;
}

/**
 * 单个本机 Agent 的 ACP transport：一个长驻适配器子进程，多 session 复用。
 * 子进程退出时活跃 run 全部落 run.failed，下次 start() 重拉进程。
 */
export class AcpAgentRuntime implements AgentRuntime {
  readonly id: string;

  private readonly sessions = new Map<string, ActiveAcpSession>();
  private readonly runs = new Map<string, string>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private initResponse: InitializeResponse | null = null;
  private connecting: Promise<void> | null = null;
  private stderrTail = "";
  private disposed = false;

  constructor(
    private readonly adapter: AcpAdapterCommand,
    private readonly workingDirectory: string,
    installationId: string,
    /**
     * 渠道会话的 EverRoom MCP 注入源（create-server 按 session 渠道锁定
     * 判定后转发到这里）；派发子任务不注入。loadSession 时适配器可能忽略
     * 该参数（claude 内存 session 持有首轮配置），故 token 需跨 run 稳定。
     */
    private readonly mcpServersForRun?: (input: StartRuntimeRunInput) => McpServer[] | Promise<McpServer[]>,
    /**
     * 渠道会话判定（与 MCP 注入同一判据）：true 时 CLI 工具权限走人工审批
     * （approval.requested 事件 + service 桥），false 维持 mutationAllowed 自动应答。
     */
    private readonly humanApprovalForRun?: (input: StartRuntimeRunInput) => boolean | Promise<boolean>,
    /** 语义权限档 → provider modeId 翻译用；缺省时权限模式能力降级（set 返回 null）。 */
    private readonly provider?: LocalAcpProvider,
  ) {
    this.id = `local:acp:${installationId}`;
  }

  private permissionRequestHandler: ((request: AcpPermissionApprovalRequest) => Promise<AcpPermissionDecision>) | null = null;

  /** AgentService 桥接点（结构化可选方法，与 pi 档 setBashApprovalHandler 同构）。 */
  setPermissionRequestHandler(handler: ((request: AcpPermissionApprovalRequest) => Promise<AcpPermissionDecision>) | null): void {
    this.permissionRequestHandler = handler;
  }

  /** 各渠道会话的目标权限档（agentSessionId 键；ACP 会话仅 run 中存活，run 间隙由这里缓冲）。 */
  private readonly desiredPermissionModes = new Map<string, { semantic: AgentPermissionMode; modeId: string }>();

  /**
   * 设置会话权限模式（语义档）。run 进行中立即下发 session/set_mode；
   * run 间隙记入缓冲，下次 drive() 在 session/new·load 后、prompt 前补发。
   * 返回 null=该 runtime 不支持（无 provider 或语义档无映射）。
   */
  async setSessionPermissionMode(agentSessionId: string, semantic: AgentPermissionMode): Promise<{ applied: boolean } | null> {
    if (!this.provider) return null;
    const modeId = permissionModeIdForProvider(this.provider, semantic);
    if (!modeId) return null;
    this.desiredPermissionModes.set(agentSessionId, { semantic, modeId });
    const active = this.activeByAgentSession(agentSessionId);
    if (!active || !this.connection) return { applied: false };
    await this.connection.setSessionMode({ sessionId: this.sessionIdOf(active), modeId });
    if (active.modes) active.modes.currentModeId = modeId;
    return { applied: true };
  }

  /** 当前模式状态快照：desired 来自缓冲，current/available 仅 run 中有效（适配器上报）。 */
  getSessionPermissionModes(agentSessionId: string): {
    desired: AgentPermissionMode | null;
    current: AgentPermissionMode | null;
    available: AgentPermissionMode[];
  } {
    const desired = this.desiredPermissionModes.get(agentSessionId)?.semantic ?? null;
    const active = this.activeByAgentSession(agentSessionId);
    if (!active?.modes || !this.provider) return { desired, current: null, available: [] };
    const current = semanticForProviderModeId(this.provider, active.modes.currentModeId);
    const available = active.modes.availableModeIds
      .map((modeId) => semanticForProviderModeId(this.provider!, modeId))
      .filter((semantic): semantic is AgentPermissionMode => Boolean(semantic));
    return { desired, current, available };
  }

  /** 会话删除后清缓冲（registry 缓存的 runtime 长驻，防跨会话泄漏）。 */
  forgetSessionPermissionMode(agentSessionId: string): void {
    this.desiredPermissionModes.delete(agentSessionId);
  }

  private activeByAgentSession(agentSessionId: string): ActiveAcpSession | null {
    for (const [sessionId, active] of this.sessions) {
      if (active.agentSessionId === agentSessionId) return active;
    }
    return null;
  }

  private sessionIdOf(active: ActiveAcpSession): string {
    for (const [sessionId, candidate] of this.sessions) {
      if (candidate === active) return sessionId;
    }
    throw new Error("local_agent_acp_session_missing");
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      streaming: true,
      reasoning: false,
      tools: true,
      steering: false,
      resume: this.initResponse?.agentCapabilities?.loadSession !== false,
    };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    if (this.runs.has(input.runId)) throw new Error("local_agent_run_already_active");
    const queue = new AsyncEventQueue<RuntimeEvent>();
    queue.push({ type: "run.started", payload: { agentId: this.id, transport: "acp" } });
    void this.drive(input, queue);
    return { runId: input.runId, runtimeSessionRef: input.runtimeSessionRef ?? "", events: queue };
  }

  async resume(input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    return this.start(input);
  }

  async sendInput(): Promise<void> {
    throw new Error("local_agent_steering_not_supported");
  }

  async cancel(runId: string): Promise<void> {
    const sessionId = this.runs.get(runId);
    if (sessionId && this.connection) {
      await this.connection.cancel({ sessionId });
    }
  }

  async deleteSession(): Promise<void> {}

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const sessionId of [...this.sessions.keys()]) {
      await this.connection?.cancel({ sessionId }).catch(() => undefined);
    }
    this.killChild();
  }

  private async drive(input: StartRuntimeRunInput, queue: AsyncEventQueue<RuntimeEvent>): Promise<void> {
    let sessionId: string | null = null;
    try {
      await this.ensureConnection();
      const mcpServers = await this.mcpServersForRun?.(input) ?? [];
      // 注入的 EverRoom MCP 工具与 pi 渠道同语义（token 即能力，不做权限门）：
      // 经 _meta.claudeCode.options.allowedTools 预授权整个服务器，否则 CLI 对每个
      // mcp__everroom__* 调用走 canUseTool→requestPermission，在无工作区绑定
      // （inspect → mutationAllowed=false）下连只读检索也会被拒。
      // 文件系统 mutation 仍走 mutationAllowed 的 requestPermission 门。
      const sessionMeta = mcpServers.length > 0
        ? { claudeCode: { options: { allowedTools: mcpServers.map((server) => `mcp__${server.name}`) } } }
        : undefined;
      // ACP spec：loadSession 成功后 sessionId 保持请求里传入的那个。
      const resumeRef = input.runtimeSessionRef;
      let sessionModes: { currentModeId: string; availableModeIds: string[] } | null = null;
      if (resumeRef && this.initResponse?.agentCapabilities?.loadSession !== false) {
        const loaded = await this.connection!.loadSession({
          sessionId: resumeRef,
          cwd: this.workingDirectory,
          mcpServers,
          ...(sessionMeta ? { _meta: sessionMeta } : {}),
        });
        sessionId = resumeRef;
        if (loaded?.modes) sessionModes = acpSessionModeSnapshot(loaded.modes);
      } else {
        const session = await this.connection!.newSession({
          cwd: this.workingDirectory,
          mcpServers,
          ...(sessionMeta ? { _meta: sessionMeta } : {}),
        });
        sessionId = session.sessionId;
        if (session.modes) sessionModes = acpSessionModeSnapshot(session.modes);
      }
      this.runs.set(input.runId, sessionId);
      this.sessions.set(sessionId, {
        queue,
        runId: input.runId,
        agentSessionId: input.sessionId,
        mutationAllowed: input.delegationContext?.grant.mutationAllowed ?? false,
        humanApproval: await this.humanApprovalForRun?.(input) ?? false,
        messageStarted: false,
        text: "",
        pendingApprovals: new Set(),
        toolCalls: new Map(),
        modes: sessionModes,
      });
      queue.push({ type: "runtime.session.updated", payload: { runtimeSessionRef: sessionId } });

      const active = this.sessions.get(sessionId)!;
      // run 间隙缓存的权限档在 prompt 前补发（ACP 会话仅 run 中存活）。
      const desiredMode = this.desiredPermissionModes.get(input.sessionId);
      if (desiredMode && active.modes && active.modes.currentModeId !== desiredMode.modeId) {
        await this.connection!.setSessionMode({ sessionId, modeId: desiredMode.modeId });
        active.modes.currentModeId = desiredMode.modeId;
      }
      const response = await this.connection!.prompt({
        sessionId,
        prompt: [{ type: "text", text: delegationPrompt(input) }],
      });
      if (this.disposed || !this.sessions.has(sessionId)) return;
      switch (response.stopReason) {
        case "end_turn":
          if (active.text.trim()) {
            if (!active.messageStarted) {
              queue.push({ type: "message.started", payload: { role: "assistant" } });
              active.messageStarted = true;
            }
            queue.push({ type: "message.completed", payload: { role: "assistant", content: active.text } });
            queue.push({ type: "run.completed", payload: {} });
          } else {
            queue.push({ type: "run.failed", payload: { message: "local_agent_no_result" } });
          }
          break;
        case "cancelled":
          queue.push({ type: "run.cancelled", payload: {} });
          break;
        default:
          queue.push({ type: "run.failed", payload: { message: `local_agent_stop_${response.stopReason}` } });
      }
    } catch (error) {
      // 连接失败（sessionId 为 null）或会话期出错都要给终态事件，
      // 否则 dispatch 消费方只能等超时；队列已被子进程退出路径收尾时 push 是 no-op。
      const detail = error instanceof Error ? error.message : String(error);
      const tail = this.stderrTail ? `: ${this.stderrTail.slice(-400)}` : "";
      queue.push({ type: "run.failed", payload: { message: `${detail}${tail}`.slice(0, 2_000) } });
    } finally {
      if (sessionId) {
        const active = this.sessions.get(sessionId);
        if (active) {
          for (const approvalId of active.pendingApprovals) {
            active.queue.push({ type: "approval.resolved", payload: { approvalId, approved: false } });
          }
          active.pendingApprovals.clear();
        }
        this.sessions.delete(sessionId);
        this.runs.delete(input.runId);
      }
      queue.end();
    }
  }

  private async ensureConnection(): Promise<void> {
    if (this.child && this.connection && this.child.exitCode === null) return;
    this.connecting ??= this.connect().finally(() => { this.connecting = null; });
    await this.connecting;
  }

  private async connect(): Promise<void> {
    // 优先主命令；ENOENT（bin 改名后旧/新版共存场景）按 fallbacks 回退重试。
    const candidates = [this.adapter.command, ...(this.adapter.fallbacks ?? [])];
    let lastError: Error | null = null;
    for (const command of candidates) {
      try {
        await this.connectWith(command);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error("local_agent_acp_adapter_unavailable");
  }

  private async connectWith(command: string): Promise<void> {
    this.killChild();
    const child = spawn(command, this.adapter.args, {
      cwd: this.workingDirectory,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // target 下发的覆盖 env（私有安装的 ELECTRON_RUN_AS_NODE、合并 PATH）最后合并。
      env: { ...childEnvironment(), ...(this.adapter.env ?? {}) },
    });
    this.stderrTail = "";
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      this.stderrTail = `${this.stderrTail}${error.message}`.slice(-MAX_STDERR_BYTES);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
    });
    child.on("exit", () => {
      if (this.child === child) this.onAdapterExit();
    });
    this.child = child;
    const connection = new ClientSideConnection(
      (agent) => this.clientHandler(agent),
      ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
    );
    this.connection = connection;
    // spawn ENOENT 只触发 child 'error'（写流坏死不一定让 initialize reject），
    // 适配器启动即退也在此兜底：两者都必须让 initialize 竞速失败。
    const startupFailure = new Promise<never>((_, reject) => {
      child.once("error", (error) => reject(new Error(`spawn ${error.message}`)));
      child.once("exit", (code, signal) => reject(new Error(`exited ${code ?? signal ?? "unknown"} before initialize`)));
    });
    try {
      this.initResponse = await Promise.race([
        connection.initialize({
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
        }),
        startupFailure,
      ]);
    } catch (error) {
      this.killChild();
      this.connection = null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`local_agent_acp_adapter_unavailable: ${command} (${detail})`);
    }
  }

  /**
   * 人工审批桥：approval.requested 事件进 run 队列（渲染层卡片），决定经
   * service 的 pending 表回填；decision 按 kind 映射回适配器给的 optionId——
   * approved→allow_once、approved_session→allow_always、denied→reject_once，
   * 对 ExitPlanMode/codex plan 等特例选项面同样成立。
   */
  private async interactivePermission(
    params: { options: Array<{ kind: string; optionId: string }>; toolCall: { toolCallId: string; title?: string | null; rawInput?: Record<string, unknown> } },
    active: ActiveAcpSession,
  ): Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }> {
    const handler = this.permissionRequestHandler!;
    const approvalId = randomUUID();
    const toolName = typeof params.toolCall.title === "string" && params.toolCall.title ? params.toolCall.title : "tool";
    const command = acpToolInputSummary(params.toolCall.rawInput) || toolName;
    active.pendingApprovals.add(approvalId);
    active.queue.push({
      type: "approval.requested",
      payload: { approvalId, kind: "tool", toolName, command, cwd: this.workingDirectory },
    });
    let decision: AcpPermissionDecision;
    try {
      decision = await handler({
        approvalId,
        agentSessionId: active.agentSessionId,
        runId: active.runId,
        toolCallId: params.toolCall.toolCallId,
        toolName,
        command,
        cwd: this.workingDirectory,
      });
    } catch {
      decision = "denied";
    } finally {
      active.pendingApprovals.delete(approvalId);
    }
    active.queue.push({
      type: "approval.resolved",
      payload: { approvalId, approved: decision === "approved" || decision === "approved_session" },
    });
    const wantedKind = decision === "approved" ? "allow_once"
      : decision === "approved_session" ? "allow_always"
        : decision === "denied" ? "reject_once"
          : null;
    if (!wantedKind) return { outcome: { outcome: "cancelled" } };
    const options = params.options ?? [];
    const option = options.find((item) => item.kind === wantedKind)
      ?? (wantedKind === "allow_always" ? options.find((item) => item.kind === "allow_once") : undefined)
      ?? (wantedKind === "reject_once" ? options.find((item) => item.kind === "reject_always") : undefined);
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  private onAdapterExit(): void {
    this.child = null;
    this.connection = null;
    this.initResponse = null;
    for (const [sessionId, active] of [...this.sessions]) {
      // 挂起的审批随 run 终止收口，避免卡片滞留 UI（service 侧 pending 由超时兜底）。
      for (const approvalId of active.pendingApprovals) {
        active.queue.push({ type: "approval.resolved", payload: { approvalId, approved: false } });
      }
      active.pendingApprovals.clear();
      active.queue.push({
        type: "run.failed",
        payload: { message: `local_agent_acp_adapter_exited: ${this.adapter.command}${this.stderrTail ? `: ${this.stderrTail.slice(-400)}` : ""}` },
      });
      active.queue.end();
      this.runs.delete(active.runId);
      this.sessions.delete(sessionId);
    }
  }

  private killChild(): void {
    this.connection = null;
    this.initResponse = null;
    if (this.child && this.child.exitCode === null) {
      this.child.removeAllListeners("exit");
      this.child.kill("SIGTERM");
    }
    this.child = null;
  }

  private clientHandler(_agent: Agent): Client {
    return {
      sessionUpdate: async (params) => {
        const active = this.sessions.get(params.sessionId);
        if (!active) return;
        const update = params.update;
        if (update.sessionUpdate === "current_mode_update") {
          // 适配器侧模式变化（ExitPlanMode 应答后切换、CLI 内自发切换）——跟随并广播语义档。
          if (active.modes) active.modes.currentModeId = update.currentModeId;
          if (this.provider) {
            const semantic = semanticForProviderModeId(this.provider, update.currentModeId);
            if (semantic) {
              const desired = this.desiredPermissionModes.get(active.agentSessionId);
              // 适配器自己切到的档视为新的目标档，避免下次 run 又切回去。
              if (desired) this.desiredPermissionModes.set(active.agentSessionId, { semantic, modeId: update.currentModeId });
              active.queue.push({ type: "session.permission_mode.updated", payload: { permissionMode: semantic } });
            }
          }
          return;
        }
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          // 渠道会话执行时间线：适配器工具调用（Bash 命令/文件读写等）映射为 tool.* 事件。
          const { events, next } = reduceAcpToolCallUpdate(
            active.toolCalls.get(update.toolCallId),
            update as AcpToolCallUpdate,
          );
          active.toolCalls.set(update.toolCallId, next);
          for (const event of events) active.queue.push(event);
          return;
        }
        if (update.sessionUpdate !== "agent_message_chunk") return;
        if (update.content.type !== "text") return;
        const delta = update.content.text;
        if (!delta) return;
        if (!active.messageStarted) {
          active.messageStarted = true;
          active.queue.push({ type: "message.started", payload: { role: "assistant" } });
        }
        active.text += delta;
        active.queue.push({ type: "message.delta", payload: { delta } });
      },
      requestPermission: async (params) => {
        const active = this.sessions.get(params.sessionId);
        if (active?.humanApproval && this.permissionRequestHandler) {
          // 语义权限档先行：档位覆盖的工具类（accept_edits 的 Read 等）在人工桥前
          // 直接放行，不再弹卡；未覆盖的走 UI 审批。
          const mode = this.desiredPermissionModes.get(active.agentSessionId)?.semantic
            ?? (this.provider && active.modes
              ? semanticForProviderModeId(this.provider, active.modes.currentModeId)
              : null);
          if (mode && permissionModeCoversToolKind(mode, params.toolCall?.kind)) {
            const options = params.options ?? [];
            const option = options.find((item) => item.kind === "allow_always")
              ?? options.find((item) => item.kind === "allow_once")
              ?? options.find((item) => item.kind.startsWith("allow"))
              ?? options[0];
            return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
          }
          return this.interactivePermission(params, active);
        }
        const wanted = active?.mutationAllowed ? "allow" : "reject";
        const options = params.options ?? [];
        const option = options.find((item) => item.kind === `${wanted}_once`)
          ?? options.find((item) => item.kind === `${wanted}_always`)
          ?? options.find((item) => item.kind.startsWith(wanted))
          ?? options[0];
        return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
      },
      readTextFile: async (params) => {
        const root = resolvePath(this.workingDirectory);
        const target = resolvePath(root, params.path);
        if (relative(root, target).startsWith("..")) {
          // 普通 Error 会被 SDK 包装成 Internal error（message 进 data.details），
          // 抛 RequestError 让对端拿到明确的 code/message。
          throw new RequestError(-32000, `local_agent_acp_read_outside_workspace: ${params.path}`);
        }
        const content = await readFile(target, "utf8");
        if (Buffer.byteLength(content, "utf8") > MAX_READ_TEXT_FILE_BYTES) {
          throw new RequestError(-32000, "local_agent_acp_read_too_large");
        }
        return { content };
      },
    };
  }
}
