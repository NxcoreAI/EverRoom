import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { DocumentService } from "./service.js";

export interface DocumentMcpContext {
  agentSessionId: string;
  runId: string;
  roomId: string | null;
}

export const DOCUMENT_MCP_TOOL_DEFINITIONS = [
  {
    name: "context_room_write_begin",
    title: "开始创建 Room 文档",
    description: "在当前 Agent 会话绑定的 Context Room 中创建文档并开始事务。成功后从 sequence=1 调用 write_append，最后调用 write_commit。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["create"] },
        title: { type: "string", minLength: 1, maxLength: 120 },
        format: { type: "string", enum: ["markdown"] },
      },
      required: ["mode", "title", "format"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "context_room_write_append",
    title: "流式追加 Room 文档正文",
    description: "按严格连续的 sequence 向文档事务追加 Markdown，正文完成后必须调用 write_commit。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        transactionId: { type: "string" },
        sequence: { type: "integer", minimum: 1 },
        text: { type: "string" },
      },
      required: ["transactionId", "sequence", "text"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "context_room_write_commit",
    title: "提交 Room 文档",
    description: "提交完整正文并生成不可变版本。finalSequence 必须等于最后一个已接收序号。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        transactionId: { type: "string" },
        finalSequence: { type: "integer", minimum: 0 },
      },
      required: ["transactionId", "finalSequence"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "context_room_write_abort",
    title: "中止 Room 文档事务",
    description: "中止事务并回滚本事务创建的文档。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        transactionId: { type: "string" },
        reason: { type: "string", maxLength: 1000 },
      },
      required: ["transactionId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
] as const;

export type DocumentMcpToolDefinition = (typeof DOCUMENT_MCP_TOOL_DEFINITIONS)[number];

export type DocumentMcpToolResult = Record<string, unknown> & {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};

function requestId(message: JSONRPCMessage): RequestId | undefined {
  return "id" in message ? message.id : undefined;
}

function keyFor(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArg(args: Record<string, unknown>, name: string, allowEmpty = false): string {
  const value = args[name];
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`INVALID_REQUEST: ${name} is required`);
  }
  return value;
}

function integerArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`INVALID_REQUEST: ${name} must be a non-negative integer`);
  }
  return Number(value);
}

function success(value: unknown) {
  const structuredContent = record(value);
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent };
}

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
  context: DocumentMcpContext;
}

export class DocumentMcpHost {
  private readonly sessions = new Map<string, Promise<HostSession>>();

  constructor(private readonly documents: DocumentService) {}

  listTools(): readonly DocumentMcpToolDefinition[] {
    return DOCUMENT_MCP_TOOL_DEFINITIONS;
  }

  async exchange(
    sessionId: string,
    message: Record<string, unknown>,
    context: DocumentMcpContext,
  ): Promise<Record<string, unknown>[]> {
    if (message.jsonrpc !== "2.0") throw new Error("Invalid MCP JSON-RPC message");
    let session = this.sessions.get(sessionId);
    if (message.method === "initialize") {
      if (session) {
        const previous = await session;
        await previous.server.close().catch(() => undefined);
      }
      session = this.createSession(context);
      this.sessions.set(sessionId, session);
    } else if (!session) {
      throw new Error("MCP session must start with initialize");
    }
    const current = await session;
    current.context = context;
    return await current.transport.exchange(message as JSONRPCMessage) as Record<string, unknown>[];
  }

  abortAgentSession(sessionId: string, reason: string): Promise<void> {
    return this.documents.abortSession(sessionId, reason);
  }

  async close(): Promise<void> {
    const sessions = await Promise.allSettled(this.sessions.values());
    this.sessions.clear();
    await Promise.all(sessions.flatMap((result) => result.status === "fulfilled"
      ? [result.value.server.close().catch(() => undefined)]
      : []));
  }

  private async createSession(context: DocumentMcpContext): Promise<HostSession> {
    const transport = new ExchangeTransport();
    const holder: HostSession = { server: null as unknown as Server, transport, context };
    const server = new Server(
      { name: "everroom-context-room", version: "1.0.0" },
      {
        capabilities: { tools: {} },
        instructions: "Document tools create Markdown documents only in the Context Room bound to this Agent session.",
      },
    );
    holder.server = server;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...DOCUMENT_MCP_TOOL_DEFINITIONS] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return await this.callTool(request.params.name, record(request.params.arguments), holder.context);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Document tool failed";
        return {
          content: [{ type: "text" as const, text: message }],
          structuredContent: { code: message.split(":", 1)[0], message },
          isError: true,
        };
      }
    });
    await server.connect(transport);
    return holder;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    context: DocumentMcpContext,
  ): Promise<DocumentMcpToolResult> {
    if (!context.roomId) throw new Error("ROOM_REQUIRED: Open a Context Room first");
    switch (name) {
      case "context_room_write_begin": {
        if (stringArg(args, "mode") !== "create" || stringArg(args, "format") !== "markdown") {
          throw new Error("INVALID_REQUEST: only create/markdown is supported");
        }
        const result = await this.documents.begin({
          title: stringArg(args, "title"),
          roomId: context.roomId,
          agentSessionId: context.agentSessionId,
          runId: context.runId,
        });
        return success({
          transactionId: result.transactionId,
          roomId: context.roomId,
          docId: result.document.id,
          state: "open",
          nextSequence: 1,
          nextAction: "context_room_write_append",
          expiresAt: result.expiresAt,
        });
      }
      case "context_room_write_append": {
        const result = await this.documents.append({
          transactionId: stringArg(args, "transactionId"),
          sessionId: context.agentSessionId,
          sequence: integerArg(args, "sequence"),
          text: stringArg(args, "text", true),
        });
        return success({
          transactionId: args.transactionId,
          acceptedSequence: args.sequence,
          ...result,
          commitRequired: true,
        });
      }
      case "context_room_write_commit": {
        const transactionId = stringArg(args, "transactionId");
        const document = await this.documents.commit({
          transactionId,
          sessionId: context.agentSessionId,
          finalSequence: integerArg(args, "finalSequence"),
        });
        return success({ transactionId, state: "committed", roomId: document.roomId, docId: document.id });
      }
      case "context_room_write_abort": {
        const transactionId = stringArg(args, "transactionId");
        const reason = typeof args.reason === "string" ? args.reason : "agent-aborted";
        await this.documents.abort(transactionId, context.agentSessionId, reason);
        return success({ transactionId, state: "aborted" });
      }
      default:
        throw new Error(`METHOD_NOT_FOUND: Unknown tool ${name}`);
    }
  }
}
