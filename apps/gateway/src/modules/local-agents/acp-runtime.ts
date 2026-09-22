import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
} from "@zed-industries/agent-client-protocol";
import type { RuntimeCapabilities } from "@nxcore/agent-contract";
import {
  AsyncEventQueue,
  type AgentRuntime,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from "@nxcore/agent-runtime";
import { childEnvironment, delegationPrompt } from "./runtime-common.js";
import {
  localAcpAdapterCommand,
  type LocalAcpProvider,
} from "@nxcore/agent-contract";

export type { LocalAcpProvider };

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_READ_TEXT_FILE_BYTES = 2 * 1024 * 1024;

export interface AcpAdapterCommand {
  command: string;
  args: string[];
}

/**
 * provider → ACP 适配器命令（映射与安装指引在 @nxcore/agent-contract 共享，
 * 桌面端安装向导用同一份）。环境变量 EVERROOM_ACP_COMMAND_<PROVIDER>
 * 可整行覆盖（测试与自定义安装位置用）。
 */
export function acpAdapterCommand(
  provider: LocalAcpProvider,
  executablePath: string,
): AcpAdapterCommand {
  const { command, args } = localAcpAdapterCommand(provider, executablePath, process.env);
  return { command, args };
}

interface ActiveAcpSession {
  queue: AsyncEventQueue<RuntimeEvent>;
  runId: string;
  mutationAllowed: boolean;
  messageStarted: boolean;
  text: string;
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
  ) {
    this.id = `local:acp:${installationId}`;
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
      // ACP spec：loadSession 成功后 sessionId 保持请求里传入的那个。
      const resumeRef = input.runtimeSessionRef;
      if (resumeRef && this.initResponse?.agentCapabilities?.loadSession !== false) {
        await this.connection!.loadSession({
          sessionId: resumeRef,
          cwd: this.workingDirectory,
          mcpServers: [],
        });
        sessionId = resumeRef;
      } else {
        const session = await this.connection!.newSession({ cwd: this.workingDirectory, mcpServers: [] });
        sessionId = session.sessionId;
      }
      this.runs.set(input.runId, sessionId);
      this.sessions.set(sessionId, {
        queue,
        runId: input.runId,
        mutationAllowed: input.delegationContext?.grant.mutationAllowed ?? false,
        messageStarted: false,
        text: "",
      });
      queue.push({ type: "runtime.session.updated", payload: { runtimeSessionRef: sessionId } });

      const active = this.sessions.get(sessionId)!;
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
    this.killChild();
    const child = spawn(this.adapter.command, this.adapter.args, {
      cwd: this.workingDirectory,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnvironment(),
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
      throw new Error(`local_agent_acp_adapter_unavailable: ${this.adapter.command} (${detail})`);
    }
  }

  private onAdapterExit(): void {
    this.child = null;
    this.connection = null;
    this.initResponse = null;
    for (const [sessionId, active] of [...this.sessions]) {
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
