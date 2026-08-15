import type { RuntimeCapabilities } from "@nxcore/agent-contract";
import {
  AsyncEventQueue,
  type AgentRuntime,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from "@nxcore/agent-runtime";
import WebSocket from "ws";
import type { DocumentMcpHost } from "../documents/mcp-host.js";

interface RemoteHttpRuntimeConfig {
  baseUrl: string;
  token: string | null;
  mcpWebSocketUrl: string | null;
}

interface ActiveRemoteRun {
  queue: AsyncEventQueue<RuntimeEvent>;
  controller: AbortController;
  remoteSessionId: string;
  content: string;
  terminal: boolean;
  channel: RemoteMcpChannel | null;
  input: StartRuntimeRunInput;
}

interface RemoteSession {
  id: string;
}

type RemoteSseEvent = {
  type?: string;
  content?: string;
  sessionId?: string;
  id?: string;
  name?: string;
  params?: Record<string, unknown>;
  status?: string;
  result?: unknown;
  error?: string;
  stage?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unwrapPayload(value: unknown): unknown {
  const record = asRecord(value);
  if (!record || !("status" in record) || !("body" in record)) return value;
  const status = Number(record.status);
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    throw new Error(`Remote Agent request failed (${String(record.status)})`);
  }
  return record.body;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

class RemoteMcpChannel {
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private readinessTimer: NodeJS.Timeout | null = null;
  private resolveReadiness: (() => void) | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly token: string | null,
    private readonly remoteSessionId: string,
    private readonly context: StartRuntimeRunInput,
    private readonly host: DocumentMcpHost,
  ) {}

  start(): Promise<void> {
    const readiness = new Promise<void>((resolve) => {
      this.resolveReadiness = resolve;
      this.readinessTimer = setTimeout(() => this.markReady(), 2_000);
    });
    this.connect();
    return readiness;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.markReady();
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.endpoint, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
    });
    this.socket = socket;
    socket.on("open", () => {
      this.reconnectAttempt = 0;
      socket.send(JSON.stringify({
        type: "device_mcp_register",
        protocol: "mcp-jsonrpc-2.0",
        deviceId: `everroom-ce-${process.pid}`,
        agentSessionId: this.remoteSessionId,
      }));
    });
    socket.on("message", (data) => void this.handle(data.toString()));
    socket.on("close", () => {
      this.markReady();
      this.scheduleReconnect();
    });
    socket.on("error", () => undefined);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(10_000, 500 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async handle(raw: string): Promise<void> {
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (
      request.type !== "device_mcp_request"
      || request.protocol !== "mcp-jsonrpc-2.0"
      || typeof request.requestId !== "string"
      || typeof request.sessionId !== "string"
      || !asRecord(request.message)
    ) return;
    const message = request.message as Record<string, unknown>;

    try {
      const messages = await this.host.exchange(
        request.sessionId,
        message,
        {
          agentSessionId: this.context.sessionId,
          runId: this.context.runId,
          roomId: this.context.roomId,
        },
      );
      this.send({
        type: "device_mcp_response",
        protocol: "mcp-jsonrpc-2.0",
        requestId: request.requestId,
        sessionId: request.sessionId,
        messages,
      });
      if (message.method === "tools/list") this.markReady();
    } catch (error) {
      this.send({
        type: "device_mcp_response",
        protocol: "mcp-jsonrpc-2.0",
        requestId: request.requestId,
        sessionId: request.sessionId,
        messages: [],
        error: {
          code: "MCP_EXECUTION_FAILED",
          message: error instanceof Error ? error.message : "MCP request failed",
        },
      });
    }
  }

  private send(value: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value));
  }

  private markReady(): void {
    if (!this.resolveReadiness) return;
    if (this.readinessTimer) clearTimeout(this.readinessTimer);
    this.readinessTimer = null;
    const resolve = this.resolveReadiness;
    this.resolveReadiness = null;
    resolve();
  }
}

export class RemoteHttpAgentRuntime implements AgentRuntime {
  readonly id = "remote-http";
  private readonly config: RemoteHttpRuntimeConfig;
  private readonly activeRuns = new Map<string, ActiveRemoteRun>();

  constructor(config: RemoteHttpRuntimeConfig, private readonly mcpHost: DocumentMcpHost) {
    this.config = { ...config, baseUrl: normalizeBaseUrl(config.baseUrl) };
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      streaming: true,
      reasoning: true,
      tools: this.config.mcpWebSocketUrl !== null,
      steering: false,
      resume: false,
    };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    if (this.activeRuns.has(input.runId)) throw new Error(`Remote run already active: ${input.runId}`);
    const remoteSessionId = input.runtimeSessionRef ?? (await this.createRemoteSession()).id;
    const queue = new AsyncEventQueue<RuntimeEvent>();
    const controller = new AbortController();
    const channel = this.config.mcpWebSocketUrl
      ? new RemoteMcpChannel(
          this.config.mcpWebSocketUrl,
          this.config.token,
          remoteSessionId,
          input,
          this.mcpHost,
        )
      : null;
    const active: ActiveRemoteRun = {
      queue,
      controller,
      remoteSessionId,
      content: "",
      terminal: false,
      channel,
      input,
    };
    this.activeRuns.set(input.runId, active);
    await channel?.start();
    queue.push({ type: "run.started", payload: {} });
    queue.push({ type: "message.started", payload: { role: "assistant" } });
    void this.consumeChat(input.runId, input.prompt, active);
    return { runId: input.runId, runtimeSessionRef: remoteSessionId, events: queue };
  }

  async resume(_input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    throw new Error("Remote runs are replayed from the Gateway event store");
  }

  async sendInput(): Promise<void> {
    throw new Error("Remote HTTP runtime does not support steering");
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.controller.abort();
    await fetch(`${this.config.baseUrl}/chat/abort`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sessionId: active.remoteSessionId, requestId: runId }),
    }).catch(() => undefined);
    await this.finish(runId, "cancelled");
  }

  async deleteSession(runtimeSessionRef: string): Promise<void> {
    const response = await fetch(`${this.config.baseUrl}/session/${encodeURIComponent(runtimeSessionRef)}`, {
      method: "DELETE",
      headers: this.headers(),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Remote session deletion failed (${String(response.status)})`);
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.activeRuns.keys()].map((runId) => this.cancel(runId)));
  }

  private async createRemoteSession(): Promise<RemoteSession> {
    const response = await fetch(`${this.config.baseUrl}/session`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: "{}",
    });
    const payload = unwrapPayload(await response.json().catch(() => null));
    const session = asRecord(Array.isArray(payload) ? payload[0] : payload);
    if (!response.ok || typeof session?.id !== "string") {
      throw new Error(`Remote Agent session creation failed (${String(response.status)})`);
    }
    return { id: session.id };
  }

  private async consumeChat(runId: string, prompt: string, active: ActiveRemoteRun): Promise<void> {
    try {
      const response = await fetch(`${this.config.baseUrl}/chat`, {
        method: "POST",
        headers: this.headers({
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        }),
        body: JSON.stringify({
          message: prompt,
          sessionId: active.remoteSessionId,
          requestId: runId,
          context: {
            pageLabel: active.input.pageLabel,
            roomId: active.input.roomId,
          },
        }),
        signal: active.controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Remote Agent chat failed (${String(response.status)})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminalFrame = false;
      const consumeLines = (final: boolean): void => {
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          terminalFrame = this.handleSse(runId, line.slice(5).trim(), active);
          if (terminalFrame) break;
        }
        if (final && !terminalFrame && buffer.startsWith("data:")) {
          terminalFrame = this.handleSse(runId, buffer.slice(5).trim(), active);
          buffer = "";
        }
      };
      while (!terminalFrame) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        consumeLines(false);
      }
      buffer += decoder.decode();
      consumeLines(true);
      if (!active.terminal) await this.finish(runId, "completed");
    } catch (error) {
      if (active.controller.signal.aborted) {
        await this.finish(runId, "cancelled");
      } else {
        await this.finish(runId, "failed", error);
      }
    }
  }

  private handleSse(runId: string, data: string, active: ActiveRemoteRun): boolean {
    if (data === "[DONE]") {
      void this.finish(runId, "completed");
      return true;
    }
    let event: RemoteSseEvent;
    try {
      event = JSON.parse(data) as RemoteSseEvent;
    } catch {
      return false;
    }
    if (event.type === "text" && typeof event.content === "string") {
      active.content += event.content;
      active.queue.push({ type: "message.delta", payload: { delta: event.content } });
    } else if (event.type === "reasoning" && typeof event.content === "string") {
      active.queue.push({ type: "reasoning.delta", payload: { delta: event.content } });
    } else if (event.type === "tool_call" && event.id && event.name) {
      const type = event.status === "completed"
        ? "tool.completed"
        : event.status === "error" ? "tool.failed" : "tool.started";
      active.queue.push({
        type,
        payload: {
          toolCallId: event.id,
          name: event.name,
          args: event.params ?? {},
          result: event.result,
          error: event.error,
        },
      });
    } else if (event.type === "tool_call_progress" && event.id && event.name) {
      active.queue.push({
        type: "tool.updated",
        payload: { toolCallId: event.id, name: event.name, stage: event.stage, status: event.status },
      });
    } else if (event.type === "done") {
      void this.finish(runId, "completed");
      return true;
    }
    return false;
  }

  private async finish(
    runId: string,
    outcome: "completed" | "failed" | "cancelled",
    error?: unknown,
  ): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active || active.terminal) return;
    active.terminal = true;
    active.channel?.stop();
    if (outcome === "completed") {
      active.queue.push({ type: "message.completed", payload: { role: "assistant", content: active.content } });
      active.queue.push({ type: "run.completed", payload: {} });
    } else if (outcome === "cancelled") {
      active.queue.push({ type: "run.cancelled", payload: {} });
    } else {
      active.queue.push({
        type: "run.failed",
        payload: { message: error instanceof Error ? error.message : "Remote Agent failed" },
      });
    }
    active.queue.end();
    this.activeRuns.delete(runId);
    await this.mcpHost.abortAgentSession(active.input.sessionId, `agent-run-${outcome}`);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}), ...extra };
  }
}
