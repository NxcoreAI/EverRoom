import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { DEFAULT_MAX_NOOP_TOOL_CALLS, isNoOpToolCall } from "./noop-tool-call.js";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import type { AgentContextUsageSegment, AgentPermissionMode, RuntimeCapabilities } from "@nxcore/agent-contract";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  estimateTokens,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "pi-mcp-adapter";
import { Type } from "typebox";
import {
  AsyncEventQueue,
  type AgentRuntime,
  type AgentRuntimeDescription,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from "@nxcore/agent-runtime";
import { clampToolResultText, guardRunMessages, type RunContextGuardOptions } from "./context-budget.js";
import { buildActiveFileContext, buildOpenFilesContext } from "./active-file-context.js";
import { buildLibraryInventoryContext } from "./library-inventory-context.js";

export { buildActiveFileContext, buildOpenFilesContext } from "./active-file-context.js";
export { buildLibraryInventoryContext } from "./library-inventory-context.js";
export type { RunContextGuardOptions } from "./context-budget.js";
export type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type PiApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type PiReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Pi 内置工具全集（core/tools ToolName），与自定义工具区分开。 */
export type PiBuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export const DEFAULT_PI_BUILTIN_TOOLS: PiBuiltinToolName[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];

export interface PiAgentRuntimeConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  api: PiApi;
  maxTokens: number;
  contextWindow: number;
  temperature: number;
  reasoning: PiReasoningLevel;
  sessionsDir: string;
  workingDirectory: string;
  agentDirectory: string;
  /** Optional per-agent metadata used by the Gateway resolver. */
  runtimeId?: string;
  runtimeRole?: "user-facing" | "internal";
  /** 启用时将 skillPrompts 内联进系统提示词（无 read 工具也能生效）。 */
  skillsEnabled?: boolean;
  /**
   * Skill 名 → SKILL.md 全文。内联注入系统提示词；additionalSkillPaths 的
   * 文件发现机制依赖 read 工具，toolsEnabled=false 的运行（如选区重写）不可用。
   */
  skillPrompts?: Record<string, string>;
  systemPrompt?: string;
  includeBashTool?: boolean;
  maxToolCallsPerRun?: number;
  /**
   * 连续多少次"无副作用工具调用"（echo/printf/read /dev/null 之类打点）判定为空转并
   * 中止 run。模型偶尔用 echo 当心跳，实测有 run 连刷 269 次直到用户手动取消。
   * 缺省 DEFAULT_MAX_NOOP_TOOL_CALLS；0/负数关闭。
   */
  maxNoOpToolCalls?: number;
  /**
   * 单条工具结果进入上下文的字符预算（JSON 感知截断）；缺省/0 = 不截断。
   * 建议只在子 Agent runtime 配置：主 Agent 的文档 read/patch 需要完整结果。
   */
  maxToolResultChars?: number;
  /**
   * run 内轮次级工具历史裁剪：真实上下文 token（provider usage；拿不到时退化
   * 为 CJK 感知估算）超过 triggerTokens 后，把最近 keepRecentTurns 轮之外的
   * toolResult 正文 / assistant 工具参数替换为占位符。
   * 只在「发给模型的那份上下文」生效，会话落盘与事件流保持完整。缺省关闭。
   */
  runContextGuard?: RunContextGuardOptions;
  /** Pi 内置工具白名单；缺省启用全部（read/bash/edit/write/grep/find/ls），可经 NXCORE_PI_TOOLS 收窄。 */
  builtinTools?: string[];
  /** MCP 服务器注入配置（pi-mcp-adapter）；mcpServers 为空时不挂载适配器。 */
  mcp?: {
    mcpServers: Record<string, unknown>;
  };
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
  };
  /** Restricts shell execution to an explicit sandbox policy. */
  bashSandbox?: {
    allowedRoots?: string[];
    timeoutMs?: number;
    /** Commands matching any expression are rejected before approval. Default: none — everything goes through approval UI. */
    deniedPatterns?: string[];
  };
}

export interface PiBashApprovalRequest {
  approvalId: string;
  input: StartRuntimeRunInput;
  command: string;
  cwd: string;
  timeoutMs: number;
  /** 审批卡类型：shell（bash 命令）| edit（文件写入 edit/write）；缺省 shell。 */
  kind?: "shell" | "edit";
  /** 审批卡上的工具名；缺省 "bash"。 */
  toolName?: string;
}

export interface PiAgentRuntimeToolResult {
  content: string;
  details?: unknown;
}

export interface PiAgentRuntimeToolFailurePolicy {
  category: string;
  recoverable: boolean;
  recommendedTool?: string;
  instruction: string;
  retryKey?: string;
  maxAttempts?: number;
}

export interface PiAgentRuntimeTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  promptSnippet?: string;
  promptGuidelines?: string[];
  executionMode?: "sequential" | "parallel";
  execute: (
    input: StartRuntimeRunInput,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    /** 执行中进度（pi tool_execution_update → tool.updated → 渲染层 partialResult）。 */
    onUpdate?: (partialResult: PiAgentRuntimeToolResult) => void,
  ) => Promise<PiAgentRuntimeToolResult>;
  classifyFailure?: (
    error: unknown,
    input: StartRuntimeRunInput,
    params: Record<string, unknown>,
  ) => PiAgentRuntimeToolFailurePolicy | null;
}

export interface PiAgentRuntimeIntegration {
  tools?: readonly PiAgentRuntimeTool[];
  executeMcpCall?: <T>(
    input: StartRuntimeRunInput,
    tool: string,
    invoke: () => Promise<T>,
  ) => Promise<T>;
  promptGuidelines?: readonly string[];
  onRunFinished?: (
    input: StartRuntimeRunInput,
    outcome: "completed" | "failed" | "cancelled",
  ) => Promise<void>;
  /**
   * 本轮 run 的项目根（项目空间目录）。返回绝对路径时，该会话的 cwd、文件工具的
   * 相对路径基准、bash 沙箱根都改用它；返回 null/缺省时沿用 `config.workingDirectory`。
   * 由网关按 `input.workspaceId` 解析：只有绑定了目录的项目空间才有值。
   *
   * 这是「工作目录」而不是「安全边界」——pi 没有内置沙箱（pi docs/security.md），
   * 越界读写仍由审批链路与人把关。
   */
  resolveProjectRoot?: (input: StartRuntimeRunInput) => string | null | Promise<string | null>;
  /** Called before a sandboxed shell command runs. Returning false denies it. */
  requestBashApproval?: (request: PiBashApprovalRequest) => Promise<boolean>;
  /** Returns whether bash has already been approved for the current Agent session. */
  isBashSessionAuthorized?: (sessionId: string) => boolean;
  /** Returns whether file edits (edit/write) have been session-approved for the Agent session. */
  isEditSessionAuthorized?: (sessionId: string) => boolean;
}

interface PiRunContextRef {
  current: StartRuntimeRunInput | null;
}

interface PiSessionHandle {
  ref: string;
  session: AgentSession;
  /** 建会话时生效的 cwd（项目空间根或 agent 默认工作目录）；变化时需重建会话。 */
  cwd: string;
  toolNames: string[];
  context: PiRunContextRef;
  activeRunId: string | null;
  ownerSessionId: string | null;
}

interface ActivePiRun {
  queue: AsyncEventQueue<RuntimeEvent>;
  handle: PiSessionHandle;
  input: StartRuntimeRunInput;
  unsubscribe: () => void;
  content: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  stopReason?: string;
  cancelled: boolean;
  toolCallCount: number;
  toolLimitExceeded: boolean;
  /** 连续无副作用工具调用计数与超限标记（空转守卫）。 */
  noOpStreak: number;
  noOpLimitExceeded: boolean;
  terminal: boolean;
  finishPromise: Promise<void> | null;
}

const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TOOL_HISTORY_SUMMARY_MAX_CHARS = 8_000;

/** 项目空间里作为 project instructions 注入的约定文件（与 pi 的 context file 同名）。 */
export const PROJECT_INSTRUCTIONS_FILENAME = "AGENTS.md";
/** 注入上限：整份 system prompt 每轮都要发给模型，超长文件只截断不报错。 */
const PROJECT_INSTRUCTIONS_MAX_CHARS = 16_000;

/**
 * 读取项目根下的 `AGENTS.md`（空间级人设 / 约定）。
 *
 * 为什么手工读：本 runtime 建会话时关掉了 pi 的 context file 自动发现
 * （`noContextFiles: true`），否则 agent 默认工作目录里的残留文件也会被吸进提示词。
 * 这里只对「项目空间根」显式加载，读一次、随会话缓存。
 */
export async function loadProjectInstructions(root: string): Promise<string | null> {
  try {
    const text = (await readFile(join(root, PROJECT_INSTRUCTIONS_FILENAME), "utf8")).trim();
    if (!text) return null;
    return text.length > PROJECT_INSTRUCTIONS_MAX_CHARS
      ? `${text.slice(0, PROJECT_INSTRUCTIONS_MAX_CHARS)}\n（AGENTS.md 过长，已截断）`
      : text;
  } catch {
    return null;
  }
}

function createBashSandboxExtension(
  config: PiAgentRuntimeConfig,
  runtime: PiAgentRuntime,
  getInput: () => StartRuntimeRunInput | null,
  sessionCwd: string,
): ExtensionFactory {
  const policy = config.bashSandbox ?? {};
  // 允许根 = 策略声明的根 ∪ 本会话 cwd（项目空间根）。cwd 由运行时按空间选定、
  // 模型改不了，所以这一条只是形状自检；真正的越界防护靠审批链路与人的判断
  // （pi 无内置沙箱，见 pi docs/security.md 与本仓库 docs/project-space-layout-plan）。
  const cwd = resolve(sessionCwd);
  const allowedRoots = [...(policy.allowedRoots ?? []), cwd].map((root) => `${resolve(root)}${sep}`);
  const timeoutMs = Math.max(1_000, policy.timeoutMs ?? 30_000);
  // ponytail: 默认不硬拒任何命令（sudo/rm 等一律走审批 UI 由用户决定）；
  // 正则粗筛误伤率高于收益，需要收紧时由部署方显式传 deniedPatterns。
  const deniedPatterns = (policy.deniedPatterns ?? []).map((pattern) => new RegExp(pattern, "i"));
  return (pi) => {
    pi.on("tool_call", async (event) => {
      if (event.toolName !== "bash") return;
      const command = String(event.input.command ?? "").trim();
      if (!allowedRoots.some((root) => cwd === root.slice(0, -1) || cwd.startsWith(root))) {
        throw new Error("shell_cwd_not_allowed");
      }
      if (deniedPatterns.some((pattern) => pattern.test(command))) {
        throw new Error("shell_command_denied_by_policy");
      }
      const input = getInput();
      if (!input) throw new Error("shell_run_context_missing");
      const approved = await runtime.requestBashApproval({
        approvalId: randomUUID(),
        input,
        command,
        cwd,
        timeoutMs: Math.min(
          timeoutMs,
          typeof event.input.timeout === "number" ? event.input.timeout : timeoutMs,
        ),
      });
      if (!approved) throw new Error("shell_execution_not_approved");
    });
  };
}

function createPermissionGateExtension(
  runtime: PiAgentRuntime,
  getInput: () => StartRuntimeRunInput | null,
  sessionCwd: string,
): ExtensionFactory {
  const cwd = resolve(sessionCwd);
  return (pi) => {
    pi.on("tool_call", async (event) => {
      if (event.toolName !== "edit" && event.toolName !== "write") return;
      const input = getInput();
      if (!input) throw new Error("edit_run_context_missing");
      const path = String(
        (event.input as Record<string, unknown> | undefined)?.path ?? "",
      );
      const approved = await runtime.requestEditApproval({
        approvalId: randomUUID(),
        input,
        command: path || event.toolName,
        cwd,
        timeoutMs: 30_000,
        toolName: event.toolName,
      });
      if (!approved) {
        return { block: true, reason: "edit_execution_not_approved" };
      }
    });
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("");
}

function stripRunEnvelope(text: string): string {
  const marker = "\n用户请求：";
  const index = text.lastIndexOf(marker);
  return (index >= 0 ? text.slice(index + marker.length) : text).trim();
}

function sanitizeConversationText(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[internal-id]")
    .replace(/<\/?think>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 工具名已由 context_room_ 改为 document_ / office_ / slides_ / sheets_ / connector_ 前缀，旧前缀也要认。
const TOOL_NAME_PREFIX = "(?:context_room|document|office|slides|sheets|connector)";

function looksLikeLeakedToolProtocol(text: string): boolean {
  return new RegExp(`\\{\\s*["']name["']\\s*:\\s*["']${TOOL_NAME_PREFIX}_`, "i").test(text)
    || new RegExp(`${TOOL_NAME_PREFIX}_\\w+["']?\\s*,\\s*["']arguments`, "i").test(text);
}

/** Keep conversation continuity while removing run-scoped tool payloads from the next run. */
type StripThinkingMessage = {
  role?: string;
  content?: Array<{ type?: string } | null>;
};

function dropAssistantThinkingInPlace(message: StripThinkingMessage | undefined): void {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
  const rest = message.content.filter((block) => block?.type !== "thinking");
  // 纯思考消息（思考被中断等）保留原样，避免落出空 content 的 assistant 消息
  if (rest.length === 0 || rest.length === message.content.length) return;
  message.content = rest;
}

/**
 * 中转模型经 reasoning_content 回传思考块，pi 会把思考块随历史逐轮重发并落盘
 * （实测落页子代理历史中思考文字约为正文的 290 倍，两度触发上下文压缩）。
 * pi 核心把同一条 assistant 消息对象既写进 agent 上下文又交给 SessionManager 落盘，
 * 因此在 appendMessage 入口原地剥除思考块，可同时让后续请求与会话文件都不再携带；
 * buildSessionContext 再过滤一次，兼容修复前已落盘的旧会话。
 */
export function wrapSessionManagerDroppingThinking(manager: SessionManager): SessionManager {
  return new Proxy(manager, {
    get(target, prop) {
      if (prop === "appendMessage") {
        return (message: StripThinkingMessage) => {
          dropAssistantThinkingInPlace(message);
          return target.appendMessage(message as never);
        };
      }
      if (prop === "buildSessionContext") {
        return (...args: Parameters<SessionManager["buildSessionContext"]>) => {
          const context = target.buildSessionContext(...args);
          for (const message of (context?.messages ?? []) as StripThinkingMessage[]) {
            dropAssistantThinkingInPlace(message);
          }
          return context;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SessionManager;
}

interface TurnContextSnapshotLike {
  context?: { messages?: unknown[]; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * run 内上下文守卫：包一层 pi 的 prepareNextTurnWithContext（每个模型轮次前调用），
 * 上下文超阈值时裁剪旧工具载荷。pi 的自动压缩只在整轮 run 结束后触发，子 Agent
 * 一次 prompt 里几十个工具轮次等不到它；这里补上轮次级裁剪。
 *
 * pi-coding-agent 已把 SessionManager 的 systemPrompt/tools 刷新挂在该钩子外层，
 * 所以必须「先调 previous 再改 messages」，不能整段覆盖。
 */
function installRunContextGuard(session: AgentSession, options: RunContextGuardOptions): void {
  const agent = session.agent as unknown as {
    prepareNextTurnWithContext?: (
      turn: { context: { messages?: unknown[] } },
      signal?: AbortSignal,
    ) => Promise<TurnContextSnapshotLike | undefined> | TurnContextSnapshotLike | undefined;
  };
  const previous = agent.prepareNextTurnWithContext;
  agent.prepareNextTurnWithContext = async (turn, signal) => {
    const snapshot = previous ? await previous.call(agent, turn, signal) : undefined;
    const context = snapshot?.context ?? turn.context;
    const messages = context?.messages;
    if (!Array.isArray(messages)) return snapshot;
    // 阈值用 provider 真实 usage 判定：chars/4 对中文 + JSON 内容会低估一半以上，
    // 旧口径下 128k 窗口要估到 256k 字符才触发，实际早已越过 pi 的 overflow 线。
    let usageTokens: number | null = null;
    try {
      usageTokens = session.getContextUsage()?.tokens ?? null;
    } catch {
      // 用量拿不到时退回 CJK 感知估算，不能因此中断本轮对话。
    }
    const guarded = guardRunMessages(messages, options, usageTokens);
    if (guarded === messages) return snapshot;
    return {
      ...(snapshot ?? {}),
      context: { ...(context as Record<string, unknown>), messages: [...guarded] },
    };
  };
}

function compactHistoricalToolState(session: AgentSession): boolean {
  const messages = session.messages;
  const hasRunScopedPayload = messages.some((message) => message.role === "toolResult");
  if (!hasRunScopedPayload) return false;

  const transcript: string[] = [];
  for (const message of messages) {
    if (message.role === "compactionSummary") {
      const summary = sanitizeConversationText(message.summary);
      if (summary) transcript.push(summary);
      continue;
    }
    if (message.role === "user") {
      const text = sanitizeConversationText(stripRunEnvelope(messageText(message.content)));
      if (text) transcript.push(`用户：${text.slice(0, 1_500)}`);
      continue;
    }
    if (message.role !== "assistant" || message.stopReason !== "stop") continue;
    const text = sanitizeConversationText(messageText(message.content));
    if (text && !looksLikeLeakedToolProtocol(text)) transcript.push(`助手：${text.slice(0, 1_500)}`);
  }

  const summaryBody = transcript.join("\n").slice(-TOOL_HISTORY_SUMMARY_MAX_CHARS);
  const summary = [
    "以下是同一对话此前轮次的简要上下文。工具调用、文档全文、块标识、读取凭证、Operation 标识和工具错误均已移除，不得据此判断本轮工具执行结果。",
    summaryBody || "此前轮次没有需要保留的对话内容。",
  ].join("\n");
  const markerId = session.sessionManager.appendCustomEntry("nxcore-run-tool-boundary", {
    removedToolPayloads: true,
  });
  session.sessionManager.appendCompaction(
    summary,
    markerId,
    Math.ceil(JSON.stringify(messages).length / 4),
    { reason: "nxcore-run-tool-boundary" },
    true,
  );
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
  return true;
}

export class PiAgentRuntime implements AgentRuntime {
  readonly id = "pi";
  private readonly sessions = new Map<string, PiSessionHandle>();
  private readonly activeRuns = new Map<string, ActivePiRun>();
  private modelRuntimePromise: Promise<ModelRuntime> | null = null;

  constructor(
    private readonly config: PiAgentRuntimeConfig,
    private readonly integration: PiAgentRuntimeIntegration = {},
  ) {}

  setBashApprovalHandler(handler: ((request: PiBashApprovalRequest) => Promise<boolean>) | null): void {
    if (handler) this.integration.requestBashApproval = handler;
    else delete this.integration.requestBashApproval;
  }

  setBashSessionAuthorizationChecker(checker: ((sessionId: string) => boolean) | null): void {
    if (checker) this.integration.isBashSessionAuthorized = checker;
    else delete this.integration.isBashSessionAuthorized;
  }

  setEditSessionAuthorizationChecker(checker: ((sessionId: string) => boolean) | null): void {
    if (checker) this.integration.isEditSessionAuthorized = checker;
    else delete this.integration.isEditSessionAuthorized;
  }

  /** 会话权限模式（agentSessionId 键）；缺省 accept_edits = 既有行为（edit/write 放行、bash 必审）。 */
  private readonly sessionPermissionModes = new Map<string, AgentPermissionMode>();

  setSessionPermissionMode(sessionId: string, mode: AgentPermissionMode): void {
    this.sessionPermissionModes.set(sessionId, mode);
  }

  getSessionPermissionMode(sessionId: string): AgentPermissionMode {
    return this.sessionPermissionModes.get(sessionId) ?? "accept_edits";
  }

  forgetSessionPermissionMode(sessionId: string): void {
    this.sessionPermissionModes.delete(sessionId);
  }

  /**
   * 会话级思考档位覆盖（网关 sessionId 键）；null = 跟随 this.config.reasoning。
   * 网关每轮 run 前预热，只影响 ownerSessionId 相同的缓存会话。
   */
  private readonly sessionThinkingLevels = new Map<string, PiReasoningLevel | null>();

  /**
   * 覆盖指定网关会话的思考档位：缓存里已有该会话时立即套用（pi 会按模型支持
   * 档位 clamp，且幂等）；没有缓存会话时只记下，下一轮 getSession 建会话时生效。
   * applied 表示本次是否命中缓存会话。
   */
  async setSessionThinkingLevel(
    sessionId: string,
    level: PiReasoningLevel | null,
  ): Promise<{ applied: boolean }> {
    this.sessionThinkingLevels.set(sessionId, level);
    const effective = this.sessionThinkingLevel(sessionId);
    let applied = false;
    for (const handle of this.sessions.values()) {
      if (handle.ownerSessionId !== sessionId) continue;
      // pi 的 ThinkingLevel 与 PiReasoningLevel 字面量完全一致，仅类型名不同。
      handle.session.setThinkingLevel(effective as Parameters<AgentSession["setThinkingLevel"]>[0]);
      applied = true;
    }
    return { applied };
  }

  forgetSessionThinkingLevel(sessionId: string): void {
    this.sessionThinkingLevels.delete(sessionId);
  }

  /** 当前网关会话生效的思考档位：覆盖值优先，null/缺省跟随 runtime 配置。 */
  private sessionThinkingLevel(sessionId: string): PiReasoningLevel {
    return this.sessionThinkingLevels.get(sessionId) ?? this.config.reasoning;
  }

  /** Internal bridge used by the sandbox shell tool to surface approval state. */
  async requestBashApproval(request: PiBashApprovalRequest): Promise<boolean> {
    return this.requestToolApproval({ ...request, kind: "shell", toolName: request.toolName ?? "bash" });
  }

  /** edit/write 文件变更审批（ask_before_write 档；其余档在入口直接放行）。 */
  async requestEditApproval(request: PiBashApprovalRequest): Promise<boolean> {
    return this.requestToolApproval({ ...request, kind: "edit", toolName: request.toolName ?? "edit" });
  }

  private async requestToolApproval(request: PiBashApprovalRequest & { kind: "shell" | "edit" }): Promise<boolean> {
    const mode = this.getSessionPermissionMode(request.input.sessionId);
    const isEdit = request.kind === "edit";
    // 矩阵：bash 是黑盒（一条命令可写文件），永远比文件工具保守一档——
    // auto/full_access 之外的档 bash 必审；edit 在 accept_edits 即放行。
    if (!isEdit && (mode === "auto" || mode === "full_access")) return true;
    if (isEdit && mode !== "ask_before_write") return true;
    const sessionAuthorized = isEdit
      ? this.integration.isEditSessionAuthorized?.(request.input.sessionId)
      : this.integration.isBashSessionAuthorized?.(request.input.sessionId);
    if (sessionAuthorized) return true;
    const active = this.activeRuns.get(request.input.runId);
    active?.queue.push({ type: "approval.requested", payload: {
      approvalId: request.approvalId,
      kind: request.kind,
      toolName: request.toolName ?? "bash",
      command: request.command,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
    } });
    let approved = false;
    try {
      approved = await (this.integration.requestBashApproval?.(request) ?? Promise.resolve(false));
    } catch {
      approved = false;
    }
    active?.queue.push({ type: "approval.resolved", payload: { approvalId: request.approvalId, approved } });
    return approved;
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      streaming: true,
      reasoning: this.config.reasoning !== "off",
      tools: true,
      steering: true,
      resume: false,
    };
  }

  /**
   * 调试面板数据源：只读报告本 runtime 实际装配的 systemPrompt/工具/模型参数。
   * 全部来自构造参数与 integration（与 getSession 的装配口径一致），不读任何声明文件，
   * 也不含 apiKey。
   */
  async describe(): Promise<AgentRuntimeDescription> {
    return {
      runtimeId: this.config.runtimeId ?? this.id,
      model: {
        provider: this.config.provider,
        model: this.config.model,
        baseUrl: this.config.baseUrl,
        api: this.config.api,
        reasoning: this.config.reasoning,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        contextWindow: this.config.contextWindow,
      },
      role: this.config.runtimeRole ?? null,
      // 未配置 systemPrompt 时运行期会用默认聊天人设兜底；这里如实返回 null。
      systemPrompt: this.config.systemPrompt ?? null,
      skills: Object.entries(this.config.skillPrompts ?? {}).map(([name, prompt]) => ({ name, prompt })),
      tools: [
        ...(this.integration.tools ?? []).map((tool) => ({
          name: tool.name,
          label: tool.label,
          description: tool.description,
        })),
      ],
      builtinTools: this.enabledBuiltinTools(),
      mcpServers: Object.keys(this.config.mcp?.mcpServers ?? {}),
      promptGuidelines: [...(this.integration.promptGuidelines ?? [])],
      limits: {
        maxToolCallsPerRun: this.config.maxToolCallsPerRun ?? null,
        maxToolResultChars: this.config.maxToolResultChars ?? null,
        runContextGuard: this.config.runContextGuard
          ? {
              triggerTokens: this.config.runContextGuard.triggerTokens,
              keepRecentTurns: this.config.runContextGuard.keepRecentTurns,
            }
          : null,
      },
      capabilities: await this.getCapabilities(),
    };
  }

  /**
   * 实际启用的 pi 内置工具集合：与 getSession 里 toolNames 的口径一致
   * （白名单收窄 + bash 受 includeBashTool 控制）。describe 与运行时共用，
   * 避免面板另抄一份 DEFAULT 列表而与实际装配漂移。
   */
  private enabledBuiltinTools(): PiBuiltinToolName[] {
    const configured = (this.config.builtinTools ?? DEFAULT_PI_BUILTIN_TOOLS).filter((name) =>
      DEFAULT_PI_BUILTIN_TOOLS.includes(name as PiBuiltinToolName),
    ) as PiBuiltinToolName[];
    const names: PiBuiltinToolName[] = [
      ...(this.config.includeBashTool === false ? [] : (["bash"] as PiBuiltinToolName[])),
      ...configured,
    ];
    // includeBashTool=false 是显式关闭 shell 的语义：白名单里残留的 bash 也不挂载。
    return [
      ...new Set(this.config.includeBashTool === false ? names.filter((name) => name !== "bash") : names),
    ];
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    if (this.activeRuns.has(input.runId)) throw new Error(`Pi run is already active: ${input.runId}`);
    const handle = await this.getSession(input.runtimeSessionRef, input);
    if (handle.activeRunId) throw new Error(`Pi session is already active: ${handle.activeRunId}`);
    if (handle.ownerSessionId && handle.ownerSessionId !== input.sessionId) {
      throw new Error("Pi session belongs to a different Agent session");
    }
    handle.ownerSessionId = input.sessionId;
    compactHistoricalToolState(handle.session);
    handle.context.current = input;
    handle.session.setActiveToolsByName(this.activeToolNamesFor(input, handle.toolNames));
    handle.activeRunId = input.runId;
    const queue = new AsyncEventQueue<RuntimeEvent>();
    const active: ActivePiRun = {
      queue,
      handle,
      input,
      unsubscribe: () => undefined,
      content: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cancelled: false,
      toolCallCount: 0,
      toolLimitExceeded: false,
      noOpStreak: 0,
      noOpLimitExceeded: false,
      terminal: false,
      finishPromise: null,
    };
    active.unsubscribe = handle.session.subscribe((event) => this.handleEvent(input.runId, event));
    this.activeRuns.set(input.runId, active);

    queue.push({ type: "run.started", payload: {} });
    queue.push({ type: "message.started", payload: { role: "assistant" } });
    void this.prompt(input, active);

    return { runId: input.runId, runtimeSessionRef: handle.ref, events: queue };
  }

  async resume(_input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    throw new Error("Pi runtime run replay is provided by the Gateway event store");
  }

  async sendInput(runId: string, input: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) throw new Error(`Pi run is not active: ${runId}`);
    await active.handle.session.steer(input);
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.cancelled = true;
    try {
      await active.handle.session.abort();
      await this.finish(runId, "cancelled");
    } catch (error) {
      await this.finish(runId, "failed", error);
    }
  }

  async deleteSession(runtimeSessionRef: string): Promise<void> {
    this.assertOwnedSessionPath(runtimeSessionRef);
    const handle = this.sessions.get(runtimeSessionRef);
    handle?.session.dispose();
    this.sessions.delete(runtimeSessionRef);
    await rm(runtimeSessionRef, { force: true });
  }

  async dispose(): Promise<void> {
    const activeRuns = [...this.activeRuns.entries()];
    await Promise.all(activeRuns.map(async ([runId, active]) => {
      active.cancelled = true;
      try {
        await active.handle.session.abort();
        await this.finish(runId, "cancelled");
      } catch (error) {
        await this.finish(runId, "failed", error);
      }
    }));
    for (const handle of this.sessions.values()) handle.session.dispose();
    this.sessions.clear();
  }

  private async getModelRuntime(): Promise<ModelRuntime> {
    if (this.modelRuntimePromise) return this.modelRuntimePromise;
    this.modelRuntimePromise = (async () => {
      await Promise.all([
        mkdir(this.config.sessionsDir, { recursive: true }),
        mkdir(this.config.workingDirectory, { recursive: true }),
        mkdir(this.config.agentDirectory, { recursive: true }),
      ]);
      const runtime = await ModelRuntime.create({
        authPath: resolve(this.config.agentDirectory, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      // DeepSeek 系模型：**不传 thinking 参数时上游默认开启思考**。pi 的
      // reasoning:"off" 只是不发 reasoning 参数（openai thinkingFormat 下结果为
      // 什么都不发），上游仍会先写一大段 reasoning_content。实测 deepseek-v4.1-flash
      // 对「1+1 等于几」也会先花 64 token 思考；编排/落页这类长任务因此白烧几分钟。
      // 显式声明 deepseek thinkingFormat 后，thinkingLevel=off 会落到
      // `thinking:{type:"disabled"}`（pi-ai openai-completions 的 deepseek 分支）。
      const isDeepSeek = /deepseek/i.test(this.config.model) || /deepseek\.com/i.test(this.config.baseUrl);
      runtime.registerProvider(this.config.provider, {
        baseUrl: this.config.baseUrl,
        api: this.config.api,
        authHeader: true,
        models: [{
          id: this.config.model,
          name: this.config.model,
          // deepseek 需保持 reasoning=true 才能命中 thinkingFormat 分支：
          // 关闭思考靠 thinkingLevel=off 发 disabled，而不是靠 reasoning=false。
          reasoning: isDeepSeek ? true : this.config.reasoning !== "off",
          input: ["text", "image"],
          cost: EMPTY_COST,
          contextWindow: this.config.contextWindow,
          maxTokens: this.config.maxTokens,
          samplingParams: { temperature: this.config.temperature },
          // 本 runtime 只对接网关/自建 baseUrl：pi-ai 按 URL 自动探测会把
          // 未知源当 OpenAI 官方。三类参数只对 OpenAI 官方端点安全，第三方
          // 中转/直连上游会 400：
          // - developer role：reasoning 模型系统提示词发成 developer role，
          //   中转上游只认 system（400: developer is not one of [...]）。
          // - store：litellm 等聚合器把模型路由到 Anthropic 后端时，
          //   anthropic 不支持 store 参数（400: UnsupportedParamsError，
          //   glm-5.3 经 litellm 实测）。
          // - reasoning_effort：同为 anthropic 后端不支持的参数；后台/知识
          //   工作流带 effort 调用时必 400（同环境实测）。推理本身不受影响
          //   ——GLM 系模型默认思考，thinking 照常经 reasoning_content 回传。
          compat: {
            supportsDeveloperRole: false,
            supportsStore: false,
            supportsReasoningEffort: false,
            ...(isDeepSeek ? { thinkingFormat: "deepseek" as const } : {}),
          },
        }],
      });
      await runtime.setRuntimeApiKey(this.config.provider, this.config.apiKey);
      return runtime;
    })();
    return this.modelRuntimePromise;
  }

  /**
   * 本会话的 cwd：项目空间根优先（网关按 workspaceId 解析），否则 agent 的默认
   * 工作目录。空间目录被删/搬走时解析器返回 null，这里静默回落——绝不静默重建
   * 用户的空间目录（重建成空目录会盖掉「目录丢了」这个事实）。
   */
  private async sessionCwd(input: StartRuntimeRunInput): Promise<string> {
    const fallback = resolve(this.config.workingDirectory);
    let candidate: string | null = null;
    try {
      candidate = (await this.integration.resolveProjectRoot?.(input)) ?? null;
    } catch {
      candidate = null;
    }
    const trimmed = candidate?.trim();
    if (!trimmed) return fallback;
    const root = resolve(trimmed);
    if (root === fallback) return fallback;
    try {
      if (!(await stat(root)).isDirectory()) return fallback;
    } catch {
      return fallback;
    }
    return root;
  }

  private async getSession(
    runtimeSessionRef: string | null,
    initialInput: StartRuntimeRunInput,
  ): Promise<PiSessionHandle> {
    const cwd = await this.sessionCwd(initialInput);
    if (runtimeSessionRef) {
      const cached = this.sessions.get(runtimeSessionRef);
      if (cached && cached.cwd === cwd) {
        // 复用缓存会话前同步本轮生效档位：网关可能在两轮之间改过覆盖值。
        // pi 的 setThinkingLevel 幂等（档位未变化不写 session 日志）。
        cached.session.setThinkingLevel(
          this.sessionThinkingLevel(initialInput.sessionId) as Parameters<AgentSession["setThinkingLevel"]>[0],
        );
        return cached;
      }
      if (cached) {
        // 项目根变了（空间换绑 / 搬移目录 / 首次拿到空间根）：丢掉旧 cwd 的会话句柄
        // 就地重建，历史仍从同一个 session 文件恢复，不丢上下文。
        if (cached.activeRunId) throw new Error(`Pi session is already active: ${cached.activeRunId}`);
        cached.session.dispose();
        this.sessions.delete(runtimeSessionRef);
      }
      this.assertOwnedSessionPath(runtimeSessionRef);
    }

    const modelRuntime = await this.getModelRuntime();
    const model = modelRuntime.getModel(this.config.provider, this.config.model);
    if (!model) throw new Error(`Pi model is unavailable: ${this.config.provider}/${this.config.model}`);

    const context: PiRunContextRef = { current: initialInput };
    const customToolDefinitions = [...(this.integration.tools ?? [])];
    const customTools = customToolDefinitions.map((tool) => defineTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
      ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
      parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
      ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
      execute: async (_toolCallId, params, signal, onUpdate) => {
        const input = context.current;
        if (!input) throw new Error("Pi document tool is not bound to an active run");
        const active = this.activeRuns.get(input.runId);
        if (active?.toolLimitExceeded) throw new Error(this.toolLimitErrorMessage());
        try {
          const result = await withAbortSignal(
            () => tool.execute(
              input,
              params,
              signal,
              onUpdate
                ? (partial) => onUpdate({
                    content: [{ type: "text" as const, text: partial.content }],
                    details: partial.details ?? {},
                  })
                : undefined,
            ),
            signal,
          );
          return {
            content: [{
              type: "text" as const,
              text: clampToolResultText(result.content, this.config.maxToolResultChars ?? 0),
            }],
            details: result.details ?? {},
          };
        } catch (error) {
          const failure = tool.classifyFailure?.(error, input, params);
          if (failure) {
            throw new Error(JSON.stringify({
              error: failure.category,
              recoverable: failure.recoverable,
              recommendedTool: failure.recommendedTool,
              instruction: failure.instruction,
            }), { cause: error });
          }
          throw error;
        }
      },
    }));
    const toolNames = customTools.map((tool) => tool.name);
    const builtinTools = this.enabledBuiltinTools();

    const settingsManager = SettingsManager.inMemory({
      defaultProvider: this.config.provider,
      defaultModel: this.config.model,
      defaultThinkingLevel: this.config.reasoning,
      defaultTools: toolNames,
      ...(this.config.retry ? { retry: this.config.retry } : {}),
      enableAnalytics: false,
      enableInstallTelemetry: false,
    });
    // 扩展工厂：MCP 适配器（pi-mcp-adapter，注入式隔离配置）。
    const mcpServers = this.config.mcp?.mcpServers;
    const extensionFactories = [
      createPermissionGateExtension(this, () => context.current, cwd),
      ...(this.config.bashSandbox
        ? [createBashSandboxExtension(this.config, this, () => context.current, cwd)]
        : []),
      ...(mcpServers && Object.keys(mcpServers).length > 0
        ? [
            createMcpAdapter({
              config: { mcpServers } as NonNullable<
                NonNullable<Parameters<typeof createMcpAdapter>[0]>["config"]
              >,
              ...(this.integration.executeMcpCall
                ? {
                    callTool: <T>(identity: { server: string; tool: string }, invoke: () => Promise<T>) => {
                      const input = context.current;
                      if (!input) throw new Error("MCP tool is not bound to an active run");
                      return this.integration.executeMcpCall!(input, `${identity.server}.${identity.tool}`, invoke);
                    },
                  }
                : {}),
            }),
          ]
        : []),
    ];
    // 项目空间根：cwd 与 agent 默认工作目录不同即视为「这一轮在某个项目空间里工作」。
    const agentHome = resolve(this.config.workingDirectory);
    const inProjectSpace = cwd !== agentHome;
    const projectInstructions = inProjectSpace ? await loadProjectInstructions(cwd) : null;
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.config.agentDirectory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      ...(extensionFactories.length > 0 ? { extensionFactories } : {}),
      systemPromptOverride: () => {
        // 只拼装调用方配置：bundle systemPrompt（或未配置时的聊天人设回退）、
        // Skill 内联、语言/工具说明。不在此追加面向聊天体验的通用条款——
        // 那些属于各 bundle 自己的 SYSTEM.md（main 已含等价文本；机器对机器
        // 的 runtime 声明自己的输出协议，注入聊天条款会污染其 JSON 输出）。
        const lines = [
          ...(this.config.systemPrompt ? [this.config.systemPrompt] : [
            "你是 NxCore 桌面工作区中的 AI 助手。",
            "回答应准确、简洁，并使用与用户相同的语言。",
            "聊天回复使用自然、简洁的纯文本格式；不要使用 Markdown 标题符、粗体或斜体标记、反引号、代码围栏、表格或不常用装饰符号。需要列举时只使用普通数字列表或短句。文档正文仍按文档工具要求使用 Markdown。",
            "当用户使用中文时，聊天回复、文档标题和文档正文必须使用简体中文及中国大陆常用措辞；除非用户明确要求，否则不要使用繁体中文。",
          ]),
        ];
        // 项目空间：告诉模型这一轮的实际工作根（bash/文件工具的相对路径基准），
        // 以及空间里的 AGENTS.md 约定。放在 Skill 之前——空间约定优先于通用技能话术。
        if (inProjectSpace) {
          lines.push(
            "",
            `当前会话的项目空间目录：${cwd}。bash 与文件工具的相对路径以此为基准；写入文件前确认落在该目录内。`,
          );
        }
        if (projectInstructions) {
          lines.push("", `<project-instructions source="${PROJECT_INSTRUCTIONS_FILENAME}">`, projectInstructions, "</project-instructions>");
        }
        // 内置 Skill 全文内联：toolsEnabled=false 的运行（如选区重写）没有 read
        // 工具，无法走 SDK 的"用 read 加载 SKILL.md"发现机制。
        if (this.config.skillsEnabled !== false) {
          for (const [name, prompt] of Object.entries(this.config.skillPrompts ?? {})) {
            lines.push("", `<skill name="${name}">`, prompt, `</skill>`);
          }
        }
        const responseLanguage = context.current?.responseLanguage?.trim();
        if (responseLanguage) {
          lines.push(
            `当前界面 locale：${responseLanguage}。除非用户明确要求本次输出使用另一种语言，所有 Agent 生成的自然语言内容（包括聊天答复、总结、文档标题和文档正文）都必须使用 ${responseLanguage} 对应的主要语言；代码、路径、引用、专有名词和用户原文保持原样。`,
          );
        }
        const workspaceId = context.current?.workspaceId?.trim();
        if (workspaceId) {
          const workspaceLabel = context.current?.workspaceLabel?.trim();
          lines.push(
            `当前工作区：${workspaceLabel || workspaceId}（workspaceId: ${workspaceId}）。文件检索与产物入库默认作用于该工作区（未指定 workspaceId 的工具按会话归属自动落到这里）；除非用户明确要求，不要把检索范围或产物落到其他工作区。`,
          );
        }

        // 用户画像：长期记忆沉淀的「关于用户本人」的稳定信息。放在语言约定之后、
        // 工具说明之前——它是先验认知，不是本轮任务，所以给的是「怎么用」而不是指令。
        const userProfile = context.current?.userProfilePrompt?.trim();
        if (userProfile && context.current?.toolsEnabled !== false) {
          lines.push("", userProfile);
        }
        const hasDocumentTools = customTools.some((tool) => tool.name.startsWith("document_"));
        const hasConnectorTools = customTools.some((tool) => tool.name.startsWith("connector_"));
        if (hasDocumentTools && hasConnectorTools) {
          lines.push(
            "外部服务请求必须优先使用 connector 工具；不要把 Gmail、GitHub、Notion、Google Drive、Slack、Dropbox 或其他第三方服务误当成 EverOffice 工作区文稿。只有用户明确要求创建、读取或修改 EverOffice 工作区文稿时才使用 document_* 工具。",
          );
        }
        if (context.current?.toolsEnabled !== false) {
          lines.push(...(this.integration.promptGuidelines ?? []));
        }
        return lines.join("\n");
      },
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    const sessionManager = wrapSessionManagerDroppingThinking(
      runtimeSessionRef
        ? SessionManager.open(runtimeSessionRef, this.config.sessionsDir, cwd)
        : SessionManager.create(cwd, this.config.sessionsDir),
    );
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.config.agentDirectory,
      modelRuntime,
      model,
      thinkingLevel: this.sessionThinkingLevel(initialInput.sessionId) as Parameters<AgentSession["setThinkingLevel"]>[0],
      tools: [
        ...(this.config.includeBashTool === false ? [] : ["bash"]),
        ...builtinTools,
        ...toolNames,
      ],
      customTools: [
        ...customTools,
      ],
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    if (this.config.runContextGuard) {
      installRunContextGuard(session, this.config.runContextGuard);
    }
    const ref = session.sessionFile;
    if (!ref) {
      session.dispose();
      throw new Error("Pi did not create a persistent session file");
    }
    const handle: PiSessionHandle = {
      ref,
      session,
      cwd,
      toolNames: [
        ...(this.config.includeBashTool === false ? [] : ["bash"]),
        ...builtinTools,
        ...toolNames,
      ],
      context,
      activeRunId: null,
      ownerSessionId: null,
    };
    this.sessions.set(ref, handle);
    return handle;
  }

  private assertOwnedSessionPath(sessionPath: string): void {
    const root = `${resolve(this.config.sessionsDir)}${sep}`;
    if (!resolve(sessionPath).startsWith(root)) {
      throw new Error("Pi session reference is outside the NxCore session directory");
    }
  }

  /**
   * 本回合实际激活的工具名单：toolsEnabled=false 全隐藏。
   */
  private activeToolNamesFor(input: StartRuntimeRunInput, toolNames: string[]): string[] {
    return input.toolsEnabled === false ? [] : toolNames;
  }

  private async prompt(input: StartRuntimeRunInput, active: ActivePiRun): Promise<void> {
    try {
      // The resource loader caches the system prompt per persistent session.
      // Reload after binding this run so a locale switch is reflected in the
      // system prompt before the model sees the next request.
      await active.handle.session.reload();
      active.handle.session.setActiveToolsByName(
        this.activeToolNamesFor(input, active.handle.toolNames),
      );
      // Phase 2i 后无 Room 维度：文稿一律工作区级，run 不再携带 Room 快照，
      // 提示词只保留「直接创建、不追问归属」的工作区级指引。
      const roomContext = "工作区文稿一律按工作区级文稿创建，用户要求创建、保存或写入文档时直接调用 document_write_begin，不需要用户先选择或确认归属，也不要只用文字追问归属。";
      const documentContext = input.activeDocument
        ? [
            `当前活动文档：${input.activeDocument.title}（ID: ${input.activeDocument.documentId}，版本: ${input.activeDocument.version}）。`,
            "普通续写的默认锚点是文档末尾。",
            input.activeDocument.cursorAnchorCandidate
              ? `仅在用户明确要求当前位置时可使用光标候选：块 ${input.activeDocument.cursorAnchorCandidate.blockId}，UTF-16 偏移 ${input.activeDocument.cursorAnchorCandidate.offset}。`
              : "本轮没有可靠的光标候选锚点。",
          ].join("\n")
        : input.activeFile
          // 有 Office 页签时不要再说“没有活动文档，去调 document_list”：
          // 用户说的“这份文档”几乎必然指页签里的文件，指南会误导模型去猜文稿。
          ? "当前视口没有文档内核里的活动文稿；用户正在浏览的是 Office 文件（见下一条），按它的 fileId 读取，不要先调 document_list。"
          : "当前视口没有已确认的活动文档；若用户明确要求修改已有文档，应调用 document_list 触发选择。";
      // Office 文件（Word/Excel/PPT/PDF）是 file_entries，不是文档内核的 activeDocument：
      // 这里给出“用户正在看哪一份”的唯一事实，并指明读取正文的工具（file_read）。
      const activeFileContext = buildActiveFileContext(input.activeFile);
      // 「工作区一共开了哪些页签」：只认识当前这份时，用户问“另一个文件”模型会失明。
      const openFilesContext = buildOpenFilesContext(input.openFiles, input.activeFile);
      // 「工作区文件库里有多少材料」：新会话没有任何页签时，这是模型知道库里有东西的
      // 唯一信号。只报数量——条目由模型自己 library_browse / file_search 去取，
      // 免得「最近 N 条」被当成全库。
      const libraryInventoryContext = input.toolsEnabled === false
        ? null
        : buildLibraryInventoryContext(input.libraryInventory);
      const runBoundary = input.toolsEnabled === false
        ? null
        : [
            `本轮执行 ID：${input.runId}。这是同一对话中的一次全新工具执行。`,
            "历史对话只用于理解用户意图；历史 run 的 readReceipt、operationId、patchId、工具结果和工具错误均已失效，不得复用，也不得把历史错误当成本轮结果直接回复用户。",
            "如果用户本轮明确要求创建、续写或修改文档，必须在本轮重新完成所需工具链。文档正文一律先经 document_draft 生成；修改或续写已有文档时不要先调用 document_read——直接调用 document_draft（网关会读取权威版本组装素材并为本轮代签读取凭证），随后凭返回的 invocationId 完成 patch_begin、patch_hunk 和 patch_commit，除非本轮工具返回不可恢复错误。仅当用户询问文档内容本身时才使用 document_read。",
            "不得要求用户提供 readReceipt、operationId、patchId、blockId 或 patch markdown；这些都是 Agent 应通过工具获取和组织的内部参数。",
          ].join("\n");
      const prompt = [
        `当前工作区：${input.pageLabel}`,
        roomContext,
        documentContext,
        ...(activeFileContext ? [activeFileContext] : []),
        ...(openFilesContext ? [openFilesContext] : []),
        ...(libraryInventoryContext ? [libraryInventoryContext] : []),
        ...(runBoundary ? [runBoundary] : []),
        "",
        `用户请求：${input.prompt}`,
      ].join("\n");
      const attachmentText = input.attachments?.filter((attachment) => attachment.text).map((attachment) => [
        `附件：${attachment.filename}`,
        "<attachment_text>",
        attachment.text,
        "</attachment_text>",
      ].join("\n")) ?? [];
      const promptText = attachmentText.length ? `${prompt}\n\n${attachmentText.join("\n\n")}` : prompt;
      const images = input.attachments?.filter((attachment) => attachment.dataUrl).map((attachment) => ({
        type: "image" as const,
        data: attachment.dataUrl!.replace(/^data:[^;]+;base64,/, ""),
        mimeType: attachment.mimeType,
      }));
      try {
        await active.handle.session.prompt(
          promptText,
          { expandPromptTemplates: false, source: "rpc", ...(images?.length ? { images } : {}) },
        );
      } catch (error) {
        if (images?.length) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Pi vision model unavailable: ${message}`, { cause: error });
        }
        throw error;
      }
      if (!active.terminal) await this.finish(input.runId, active.cancelled ? "cancelled" : "completed");
    } catch (error) {
      if (active.cancelled) {
        await this.finish(input.runId, "cancelled");
      } else {
        await this.finish(input.runId, "failed", error);
      }
    }
  }

  private handleEvent(runId: string, event: AgentSessionEvent): void {
    const active = this.activeRuns.get(runId);
    if (!active || active.terminal) return;

    // Account before tools execute: structured submission can stop the consumer
    // before turn_end, including on the very first model request.
    if (event.type === "message_end" && event.message.role === "assistant") {
      active.stopReason = event.message.stopReason;
      const usage = (event.message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
      if (usage) {
        active.usage.input += usage.input ?? 0;
        active.usage.output += usage.output ?? 0;
        active.usage.cacheRead += usage.cacheRead ?? 0;
        active.usage.cacheWrite += usage.cacheWrite ?? 0;
      }
      this.emitContextUsage(active);
      return;
    }

    if (event.type === "compaction_start") {
      active.queue.push({
        type: "context.compaction",
        payload: { active: true, reason: event.reason },
      });
      return;
    }

    if (event.type === "compaction_end") {
      active.queue.push({
        type: "context.compaction",
        payload: {
          active: false,
          reason: event.reason,
          ...(event.errorMessage ? { error: event.errorMessage } : {}),
        },
      });
      // 压缩后旧用量不可信（pi 约定 tokens/percent 为 null），透出快照让 UI 及时回落。
      this.emitContextUsage(active);
      return;
    }

    if (event.type === "auto_retry_start") {
      // pi 在流式失败后整段重试：出错的半截 assistant 消息已从 agent state
      // 移除，重试会从头重新生成。若不重置累计，每波 delta 仍追加进同一条
      // 消息，重试几次正文就重复几份（#199）。message.started 复用为
      // "消息体重启"信号（各 runtime 均只在正文首次出现前发一次），
      // 下游据此清空流式累计再重新拼接。
      active.content = "";
      active.queue.push({ type: "message.started", payload: { role: "assistant" } });
      return;
    }

    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        active.content += update.delta;
        active.queue.push({ type: "message.delta", payload: { delta: update.delta } });
      } else if (update.type === "thinking_delta") {
        active.queue.push({ type: "reasoning.delta", payload: { delta: update.delta } });
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      active.toolCallCount += 1;
      const maxToolCalls = this.config.maxToolCallsPerRun;
      if (maxToolCalls !== undefined && active.toolCallCount > maxToolCalls) {
        active.toolLimitExceeded = true;
        void this.abortForToolLimit(runId);
        return;
      }
      // 空转守卫：连续多次"打点式"调用（echo / read /dev/null）说明模型在原地转圈，
      // 继续跑只会刷满时间线而不推进任务，直接中止并如实报告。
      const noOpLimit = this.config.maxNoOpToolCalls ?? DEFAULT_MAX_NOOP_TOOL_CALLS;
      active.noOpStreak = isNoOpToolCall(event.toolName, event.args) ? active.noOpStreak + 1 : 0;
      if (noOpLimit > 0 && active.noOpStreak >= noOpLimit) {
        active.noOpLimitExceeded = true;
        void this.abortForToolLimit(runId);
        return;
      }
      active.queue.push({
        type: "tool.started",
        payload: { toolCallId: event.toolCallId, name: event.toolName, args: event.args },
      });
    } else if (event.type === "tool_execution_update") {
      active.queue.push({
        type: "tool.updated",
        payload: { toolCallId: event.toolCallId, name: event.toolName, partialResult: event.partialResult },
      });
    } else if (event.type === "tool_execution_end") {
      active.queue.push({
        type: event.isError ? "tool.failed" : "tool.completed",
        payload: { toolCallId: event.toolCallId, name: event.toolName, result: event.result },
      });
    } else if (event.type === "agent_settled") {
      const sessionError = active.handle.session.state.errorMessage;
      const lastAssistant = [...active.handle.session.state.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      const outputLimitReached = active.stopReason === "length"
        || (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "length");
      void this.finish(
        runId,
        active.cancelled
          ? "cancelled"
          : active.toolLimitExceeded || active.noOpLimitExceeded || sessionError || outputLimitReached
            ? "failed"
            : "completed",
        active.toolLimitExceeded
          ? new Error(this.toolLimitErrorMessage())
          : active.noOpLimitExceeded
            ? new Error(this.noOpLimitErrorMessage())
            : sessionError
            ? new Error(friendlyRunError(sessionError))
            : outputLimitReached
              ? new Error("本次处理达到模型输出上限，未能生成最终结论。已保留处理过程，请缩小范围后重试。")
              : undefined,
      );
    }
  }

  /** 空转中止的用户可读说明：告诉用户这不是失败在业务上，而是模型在原地打转。 */
  private noOpLimitErrorMessage(): string {
    const limit = this.config.maxNoOpToolCalls ?? DEFAULT_MAX_NOOP_TOOL_CALLS;
    return (
      `本次处理在空转：连续 ${limit} 次无副作用的工具调用（echo / read /dev/null 这类打点），` +
      "没有任何实际进展，已自动中止。可以把任务拆小、或直接说明期望的结果后重试。"
    );
  }

  private toolLimitErrorMessage(): string {
    return `Pi runtime exceeded the maximum tool calls per run (${this.config.maxToolCallsPerRun})`;
  }

  /** 把 pi 的 getContextUsage 快照 + 占用构成粗估作为 context.usage 事件推入 run 队列（token 数未知时也透传，UI 据此回落）。 */
  private emitContextUsage(active: ActivePiRun): void {
    const usage = active.handle.session.getContextUsage();
    active.queue.push({
      type: "context.usage",
      payload: {
        tokens: usage?.tokens ?? null,
        contextWindow: usage?.contextWindow ?? this.config.contextWindow,
        percent: usage?.percent ?? null,
        runUsage: { ...active.usage },
        segments: this.estimateContextSegments(active),
      },
    });
  }

  /**
   * 粗估上下文构成：系统提示 + 工具 schema 按 chars/4 估，消息按 role 分桶
   * （estimateTokens 复用 pi 的口径）。与头部 tokens 同为估算，仅供占比参考；
   * 头部 tokens 来自模型 usage（含模板开销），分段合计不与其强一致。
   */
  private estimateContextSegments(active: ActivePiRun): AgentContextUsageSegment[] {
    const session = active.handle.session;
    const segments: AgentContextUsageSegment[] = [];
    const tokensPerChar = (text: string): number => Math.ceil(text.length / 4);
    const systemPrompt = session.systemPrompt;
    if (systemPrompt) segments.push({ key: "systemPrompt", tokens: tokensPerChar(systemPrompt) });
    let toolsTokens = 0;
    for (const name of session.getActiveToolNames()) {
      const definition = session.getToolDefinition(name);
      if (!definition) continue;
      try {
        toolsTokens += tokensPerChar(JSON.stringify({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
        }));
      } catch {
        // 个别 schema 序列化失败就跳过：估算展示，不值得让它炸事件链。
      }
    }
    if (toolsTokens > 0) segments.push({ key: "tools", tokens: toolsTokens });
    const messageBuckets: Record<AgentContextUsageSegment["key"], number> = {
      systemPrompt: 0,
      tools: 0,
      user: 0,
      assistant: 0,
      toolResults: 0,
      other: 0,
    };
    for (const message of session.messages) {
      if ((message as { excludeFromContext?: boolean }).excludeFromContext) continue;
      const role = message.role;
      const key: AgentContextUsageSegment["key"] =
        role === "user" ? "user"
        : role === "assistant" ? "assistant"
        : role === "toolResult" ? "toolResults"
        : "other";
      messageBuckets[key] += estimateTokens(message);
    }
    for (const key of ["user", "assistant", "toolResults", "other"] as const) {
      if (messageBuckets[key] > 0) segments.push({ key, tokens: messageBuckets[key] });
    }
    return segments;
  }

  private async abortForToolLimit(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active || active.terminal) return;
    try {
      await active.handle.session.abort();
    } catch {
      // The run is already being terminated; preserve the limit error below.
    }
    await this.finish(runId, "failed", new Error(this.toolLimitErrorMessage()));
  }

  private finish(
    runId: string,
    outcome: "completed" | "failed" | "cancelled",
    error?: unknown,
  ): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return Promise.resolve();
    if (active.finishPromise) return active.finishPromise;
    active.terminal = true;
    active.finishPromise = (async () => {
      let finalOutcome = outcome;
      let finalError = error;
      try {
        await this.integration.onRunFinished?.(active.input, outcome);
      } catch (cleanupError) {
        finalOutcome = "failed";
        finalError = cleanupError;
      }

      if (finalOutcome === "completed") {
        active.queue.push({
          type: "message.completed",
          payload: {
            role: "assistant",
            content: active.content,
            usage: active.usage,
          },
        });
        active.queue.push({ type: "run.completed", payload: {} });
      } else if (finalOutcome === "cancelled") {
        active.queue.push({ type: "run.cancelled", payload: {} });
      } else {
        active.queue.push({
          type: "run.failed",
          payload: { message: finalError instanceof Error ? finalError.message : "Pi runtime failed" },
        });
      }

      active.handle.context.current = null;
      active.handle.activeRunId = null;
      active.unsubscribe();
      active.queue.end();
      this.activeRuns.delete(runId);
    })();
    return active.finishPromise;
  }
}

/** 运行失败文案翻译：上游 provider 的原始报错（如 404 model_not_found 的 JSON 串）
 *  对用户不可读，收口成可行动的提示；未识别的保持原文。 */
export function friendlyRunError(raw: string): string {
  if (/model_not_found|Model not exist/i.test(raw)) {
    return "当前配置的模型在服务端不可用（可能已被上游下架，或渠道未配置）。请联系管理员检查模型配置后重试。";
  }
  return raw;
}

function withAbortSignal<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(new Error("Pi tool execution aborted"));
  return new Promise<T>((resolvePromise, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => settle(() => reject(new Error("Pi tool execution aborted")));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let promise: Promise<T>;
    try {
      promise = operation();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    void promise.then(
      (value) => settle(() => resolvePromise(value)),
      (error) => settle(() => reject(error)),
    );
  });
}
