import { randomUUID } from "node:crypto";
import type { McpServer } from "@zed-industries/agent-client-protocol";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { PiAgentRuntimeTool, ToolDefinition } from "@nxcore/agent-runtime-pi";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { DocumentCapabilityRegistry } from "../documents/capabilities/registry.js";
import type { DocumentExecutionContext } from "../documents/capabilities/types.js";
import { documentToolErrorPayload } from "../documents/mcp-host.js";

/**
 * 渠道会话（Claude Code / Codex 整段锁定）的 EverRoom 工具 MCP host。
 *
 * 网关为每个渠道 agentSession 签发一个不可猜的 token，挂在
 * POST /v1/mcp/everroom/:token 上，把 DocumentMcpHost 的全部
 * context_room_* 读写能力 + 记忆/知识库/Room 检索工具以 MCP 形态暴露给
 * CLI 子进程。鉴权走 token-in-path：避免把网关全局 token 种进 CLI 子进程
 * 的环境变量。
 *
 * token 按 agentSessionId 缓存复用：claude 适配器 loadSession 续会话时
 * 忽略 mcpServers 参数（内存 session 持有首轮配置），所以换发后的旧
 * token 仍保留到 TTL 自然过期；换 Room 触发的换发只影响下一轮新建的
 * 适配器 session。
 */

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface ChannelMcpScope {
  agentSessionId: string;
  roomId: string | null;
}

/** 渠道 MCP 上挂的记忆/知识库/Room 检索工具（网关侧组装，按 scope 构造）。 */
export interface ChannelMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
}

export type ChannelKnowledgeToolsFactory = (scope: ChannelMcpScope) => ChannelMcpTool[];

export function channelToolsFromPiTools(tools: ToolDefinition[]): ChannelMcpTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as Record<string, unknown>,
    execute: async (args) => {
      // 知识库工具只用前两个参数（signal/onUpdate/ctx 不参与只读检索）；
      // pi 的 AgentToolResult 类型面不暴露 isError，运行时由知识工具带回。
      const call = tool.execute as unknown as (
        toolCallId: string,
        params: unknown,
      ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
      const result = await call("channel-mcp", args);
      return { text: result.content.map((block) => block.text).join("\n"), isError: Boolean(result.isError) };
    },
  }));
}

export function channelToolsFromRuntimeTools(
  tools: readonly PiAgentRuntimeTool[],
  scope: ChannelMcpScope,
): ChannelMcpTool[] {
  // Room 检索工具不读 run 输入（roomId 走显式参数），合成最小 runInput 仅为满足签名。
  const runInput: StartRuntimeRunInput = {
    runId: `channel-mcp:${scope.agentSessionId}`,
    sessionId: scope.agentSessionId,
    runtimeSessionRef: null,
    prompt: "",
    pageLabel: "Agent",
    roomId: scope.roomId,
  };
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    execute: async (args) => {
      const result = await tool.execute(runInput, args);
      const flagged = result as { isError?: boolean };
      return { text: result.content, isError: Boolean(flagged.isError) };
    },
  }));
}

interface ChannelMcpTokenRecord {
  token: string;
  agentSessionId: string;
  roomId: string | null;
  expiresAt: number;
}

function requestId(message: JSONRPCMessage): RequestId | undefined {
  return "id" in message ? message.id : undefined;
}

function keyFor(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

/** documents/mcp-host.ts 同款：单请求 JSON-RPC 交换 over POST。 */
class ExchangeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private started = false;
  private readonly pending = new Map<string, (messages: JSONRPCMessage[]) => void>();

  async start(): Promise<void> {
    this.started = true;
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const id = requestId(message);
    if (id === undefined) return;
    const resolve = this.pending.get(keyFor(id));
    if (!resolve) return;
    this.pending.delete(keyFor(id));
    resolve([message]);
  }

  async close(): Promise<void> {
    this.pending.clear();
    this.onclose?.();
  }

  exchange(message: JSONRPCMessage): Promise<JSONRPCMessage[]> {
    if (!this.started || !this.onmessage) throw new Error("MCP transport is not ready");
    const id = requestId(message);
    if (id === undefined) {
      this.onmessage(message);
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      this.pending.set(keyFor(id), resolve);
      this.onmessage?.(message);
    });
  }
}

interface HostSession {
  server: Server;
  transport: ExchangeTransport;
  knowledge: ChannelMcpTool[];
  readonly scope: ChannelMcpScope;
}

export class ChannelMcpHost {
  private readonly tokens = new Map<string, ChannelMcpTokenRecord>();
  private readonly tokensByAgentSession = new Map<string, string>();
  private readonly sessions = new Map<string, Promise<HostSession>>();

  constructor(
    private readonly capabilities: DocumentCapabilityRegistry,
    private readonly baseUrl: string,
    private readonly knowledgeToolFactory?: ChannelKnowledgeToolsFactory,
    private readonly log?: (
      level: "info" | "warn" | "error",
      event: string,
      fields?: Record<string, unknown>,
    ) => void,
  ) {}

  /**
   * ACP newSession/loadSession 的 mcpServers 注入源。仅渠道会话调用
   * （create-server 按 agent_sessions.activeAgentId 判定后转发）。
   */
  mcpServersForRun(input: StartRuntimeRunInput): McpServer[] {
    const record = this.ensureToken(input.sessionId, input.roomId ?? null);
    this.log?.("info", "channel.mcp.server.issued", {
      agentSessionId: input.sessionId,
      roomId: record.roomId,
    });
    return [{
      type: "http",
      name: "everroom",
      url: `${this.baseUrl.replace(/\/+$/, "")}/v1/mcp/everroom/${record.token}`,
      headers: [],
    }];
  }

  async exchangeTrusted(
    token: string,
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const record = this.resolveToken(token);
    if (!record) throw new Error("MCP_SESSION_INVALID: Channel MCP token is missing or expired");
    if (message.jsonrpc !== "2.0") throw new Error("Invalid MCP JSON-RPC message");
    let session = this.sessions.get(token);
    if (message.method === "initialize") {
      if (session) {
        const previous = await session;
        await previous.server.close().catch(() => undefined);
      }
      session = this.createSession({ agentSessionId: record.agentSessionId, roomId: record.roomId });
      this.sessions.set(token, session);
    } else if (!session) {
      throw new Error("MCP_SESSION_INVALID: Channel MCP session must start with initialize");
    }
    const current = await session;
    return await current.transport.exchange(message as JSONRPCMessage) as Record<string, unknown>[];
  }

  async closeTrustedSession(token: string): Promise<void> {
    const record = this.tokens.get(token);
    if (record && this.tokensByAgentSession.get(record.agentSessionId) === token) {
      this.tokensByAgentSession.delete(record.agentSessionId);
    }
    this.tokens.delete(token);
    const session = this.sessions.get(token);
    this.sessions.delete(token);
    if (session) await (await session).server.close().catch(() => undefined);
  }

  /** 渠道 agentSession 终结（deleteSession）时回收 token；run 级不回收。 */
  async revokeAgentSession(agentSessionId: string): Promise<void> {
    const token = this.tokensByAgentSession.get(agentSessionId);
    if (token) await this.closeTrustedSession(token);
  }

  async close(): Promise<void> {
    const sessions = await Promise.allSettled(this.sessions.values());
    this.sessions.clear();
    this.tokens.clear();
    this.tokensByAgentSession.clear();
    await Promise.all(sessions.flatMap((result) => result.status === "fulfilled"
      ? [result.value.server.close().catch(() => undefined)]
      : []));
  }

  private ensureToken(agentSessionId: string, roomId: string | null): ChannelMcpTokenRecord {
    const now = Date.now();
    const cachedToken = this.tokensByAgentSession.get(agentSessionId);
    const cached = cachedToken ? this.tokens.get(cachedToken) : undefined;
    // 复用条件：未过期且 Room 未变。换 Room 换发新 token（旧 token 留到 TTL 过期）。
    if (cached && cached.expiresAt > now && cached.roomId === roomId) return cached;

    const record: ChannelMcpTokenRecord = {
      token: randomUUID().replace(/-/g, ""),
      agentSessionId,
      roomId,
      expiresAt: now + TOKEN_TTL_MS,
    };
    this.tokens.set(record.token, record);
    this.tokensByAgentSession.set(agentSessionId, record.token);
    this.pruneExpired(now);
    return record;
  }

  private resolveToken(token: string): ChannelMcpTokenRecord | null {
    const record = this.tokens.get(token);
    if (!record || record.expiresAt <= Date.now()) return null;
    return record;
  }

  private pruneExpired(now: number): void {
    for (const [token, record] of this.tokens) {
      if (record.expiresAt > now) continue;
      if (this.tokensByAgentSession.get(record.agentSessionId) === token) {
        this.tokensByAgentSession.delete(record.agentSessionId);
      }
      this.tokens.delete(token);
      const session = this.sessions.get(token);
      this.sessions.delete(token);
      if (session) void session.then((entry) => entry.server.close().catch(() => undefined));
    }
  }

  private createSession(scope: ChannelMcpScope): Promise<HostSession> {
    const transport = new ExchangeTransport();
    const holder: HostSession = {
      server: null as unknown as Server,
      transport,
      knowledge: this.knowledgeToolFactory?.(scope) ?? [],
      scope,
    };
    const context: DocumentExecutionContext = {
      agentSessionId: scope.agentSessionId,
      runId: `channel-mcp:${scope.agentSessionId}`,
      roomId: scope.roomId,
    };
    const server = new Server(
      { name: "everroom-tools", version: "1.0.0" },
      {
        capabilities: { tools: {} },
        instructions: [
          ...this.capabilities.promptGuidelines(),
          "以上是 EverRoom 的 Context Room 与文档读写工具；此外本服务器还提供长期记忆检索（memory_search）、历史对话检索（conversation_search）与知识库检索（wiki_search/wiki_read）。涉及 EverRoom 内的 Room、文档、记忆、知识时优先使用这些工具。",
        ].join(" "),
      },
    );
    holder.server = server;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        ...this.capabilities.listTools(),
        ...holder.knowledge.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = request.params.arguments ?? {};
      const knowledge = holder.knowledge.find((tool) => tool.name === request.params.name);
      if (knowledge) {
        try {
          const result = await knowledge.execute(args);
          return { content: [{ type: "text" as const, text: result.text }], isError: result.isError };
        } catch (error) {
          const payload = documentToolErrorPayload(error);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload) }],
            structuredContent: payload,
            isError: true,
          };
        }
      }
      try {
        return await this.capabilities.execute(request.params.name, args, context);
      } catch (error) {
        const payload = documentToolErrorPayload(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: true,
        };
      }
    });
    return server.connect(transport).then(() => holder);
  }
}
