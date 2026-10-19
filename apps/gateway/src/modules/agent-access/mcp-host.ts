import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { ExchangeTransport } from "../agent/channel-mcp-host.js";
import type { AgentAccessService } from "./service.js";
import type { AgentAccessTool } from "./tools-read.js";
import type { AgentAccessState, ResolvedAgentConnection } from "./types.js";

/**
 * 外部 Agent 访问的 MCP host（PRD 第 7 章 / 附录 A.3）。
 *
 * 与 ChannelMcpHost 的关键差异：
 * - 凭证是持久化的连接 token（Authorization: Bearer，agent_connections 落库），
 *   而非进程内存的 24h token——网关重启后连接仍有效。
 * - 会话自愈：重启后客户端未重新 initialize 直接调用时自动重建会话
 *   （渠道版此时报错；持久连接的客户端可能带着旧状态直接续用）。
 * - 工具面按连接 capabilities 过滤，数据按 roomIds 过滤（tools 层执行）。
 * - 每次调用落 agent_access_events（PRD 7.5 调试页；只记工具名/状态/耗时/参数
 *   体积，不记内容）。
 */

const SERVER_INSTRUCTIONS = [
  "本服务器把 EverRoom 的积累（Room、会话、文档、文件、记忆）按授权范围提供给外部 Agent。",
  "推荐工作流：everroom_list_rooms 了解范围 → everroom_search 检索 → 命中项用 everroom_fetch 按 everroom:// URI 精读原文 → 引用时携带返回的 version 字段。",
  "所有工具返回 structuredContent.status：ok / empty（换关键词或补问用户）/ no_permission（范围外，附所需能力）/ source_lost（换来源）/ parse_failed（换变体或来源）/ stale（版本过期，data 仍是最新内容）/ duplicate（提交重放，返回原结果）。",
  "回写用 everroom_submit：submissionId 由你生成并在重试时复用（幂等）；候选（记忆/Wiki/偏好）进入待确认队列，未经用户确认不会写入长期记忆。",
  "遇到失败先调用 everroom_get_status 判断是能力未开还是服务暂不可用，避免盲目重试。",
].join(" ");

/** isError 语义：ok/empty/stale/duplicate/pending_review 是正常业务结果，其余按工具错误上抛。 */
const ERROR_LIKE_STATES = new Set(["no_permission", "source_lost", "parse_failed", "invalid_input"]);

interface HostSession {
  server: Server;
  transport: ExchangeTransport;
  tools: AgentAccessTool[];
  connection: ResolvedAgentConnection;
}

export class AgentAccessMcpHost {
  private readonly sessions = new Map<string, Promise<HostSession>>();

  constructor(
    private readonly service: AgentAccessService,
    private readonly toolsFactory: (connection: ResolvedAgentConnection) => AgentAccessTool[],
    private readonly log?: (
      level: "info" | "warn" | "error",
      event: string,
      fields?: Record<string, unknown>,
    ) => void,
  ) {}

  async exchangeTrusted(
    bearerToken: unknown,
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const token = typeof bearerToken === "string" ? bearerToken.replace(/^Bearer\s+/i, "").trim() : "";
    const connection = token ? this.service.verifyBearer(token) : null;
    if (!connection) {
      throw new Error("MCP_CONNECTION_INVALID: EverRoom connection token is missing, paused or revoked");
    }
    if (message.jsonrpc !== "2.0") throw new Error("Invalid MCP JSON-RPC message");

    if (message.method === "initialize") {
      const previous = this.sessions.get(connection.id);
      if (previous) await (await previous).server.close().catch(() => undefined);
      this.sessions.set(connection.id, this.createSession(connection));
      const clientInfo = (message.params as { clientInfo?: { name?: string } } | undefined)?.clientInfo;
      this.service.recordEvent(connection.id, "connect", {
        status: "ok",
        detail: { client: clientInfo?.name ?? null },
      });
    } else if (!this.sessions.has(connection.id)) {
      this.sessions.set(connection.id, this.createSession(connection));
    }
    const session = await this.sessions.get(connection.id)!;
    return (await session.transport.exchange(message as JSONRPCMessage)) as Record<string, unknown>[];
  }

  /** DELETE /v1/mcp/agents：只结束进程内会话；连接本身与凭证不受影响。 */
  async closeSession(bearerToken: unknown): Promise<void> {
    const token = typeof bearerToken === "string" ? bearerToken.replace(/^Bearer\s+/i, "").trim() : "";
    const connection = token ? this.service.verifyBearer(token) : null;
    if (!connection) return;
    const session = this.sessions.get(connection.id);
    this.sessions.delete(connection.id);
    if (session) await (await session).server.close().catch(() => undefined);
  }

  /** REST 侧（自检/示例查询）直接执行某连接的工具；可见性规则与 MCP 调用一致。 */
  async runTool(
    connection: ResolvedAgentConnection,
    name: string,
    args: Record<string, unknown>,
  ): Promise<AgentAccessState> {
    const tools = this.toolsFactory(connection);
    const tool = tools.find((entry) => entry.name === name && (entry.capabilities === "always"
      || entry.capabilities.some((capability) => connection.scopes.capabilities.includes(capability))));
    if (!tool) throw new Error(`agent_access_tool_unavailable:${name}`);
    const startedAt = Date.now();
    const result = await tool.execute(args);
    this.service.recordEvent(connection.id, "call", {
      tool: name,
      status: result.status,
      durationMs: Date.now() - startedAt,
      detail: { internal: true },
    });
    return result;
  }

  async close(): Promise<void> {
    const sessions = await Promise.allSettled(this.sessions.values());
    this.sessions.clear();
    await Promise.all(sessions.flatMap((result) => result.status === "fulfilled"
      ? [result.value.server.close().catch(() => undefined)]
      : []));
  }

  private createSession(connection: ResolvedAgentConnection): Promise<HostSession> {
    const transport = new ExchangeTransport();
    const tools = this.toolsFactory(connection);
    const holder: HostSession = {
      server: null as unknown as Server,
      transport,
      tools,
      connection,
    };
    const visibleTools = () => tools.filter((tool) => tool.capabilities === "always"
      || tool.capabilities.some((capability) => connection.scopes.capabilities.includes(capability)));

    const server = new Server(
      { name: "everroom-agent-access", version: "1.0.0" },
      { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
    );
    holder.server = server;

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: visibleTools().map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const tool = visibleTools().find((entry) => entry.name === name);
      if (!tool) {
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }
      const startedAt = Date.now();
      try {
        const result: AgentAccessState = await tool.execute(args as Record<string, unknown>);
        this.service.recordEvent(connection.id, "call", {
          tool: name,
          status: result.status,
          durationMs: Date.now() - startedAt,
          detail: { argsBytes: JSON.stringify(args).length },
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: ERROR_LIKE_STATES.has(result.status),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log?.("warn", "agent_access.tool.error", { tool: name, connectionId: connection.id, message });
        this.service.recordEvent(connection.id, "call", {
          tool: name,
          status: "error",
          durationMs: Date.now() - startedAt,
          detail: { message },
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "parse_failed", message }) }],
          structuredContent: { status: "parse_failed", message },
          isError: true,
        };
      }
    });

    return server.connect(transport).then(() => holder);
  }
}
