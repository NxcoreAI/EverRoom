import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentRoomReference } from "@nxcore/agent-contract";
import type { DocumentService } from "./service.js";

export interface DocumentMcpContext {
  agentSessionId: string;
  runId: string;
  roomId: string | null;
  availableRooms?: AgentRoomReference[];
}

export interface DocumentRoomRegistry {
  listReferences(): AgentRoomReference[];
}

export const DOCUMENT_MCP_TOOL_DEFINITIONS = [
  {
    name: "context_room_list",
    title: "列出可写入的 Context Room",
    description: "仅当用户已经明确要求在工作区创建、保存或写入文档，但当前视口未绑定具体 Context Room 时，必须立即调用此只读工具取得 Room 列表并触发选择 UI。满足条件时不得只回复“无法创建”“请先选择 Room”，不得询问用户是否需要列表，也不得要求用户自行提供 Room 名称。普通问答、分析、总结、整理、写方案、起草、润色或仅讨论文档时不得调用。本轮没有已确认的目标 Room 时，到此停止，不得调用 write_begin，也不得替用户猜测或选择。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "context_room_write_begin",
    title: "开始创建 Room 文档",
    description: "仅当用户已经明确要求在工作区创建、保存或写入文档，并且当前 Agent 会话已绑定具体 Context Room，或用户已通过 Room 列表明确选择目标后，才能创建文档并开始事务。工具可用、当前位于文档页面、回复内容较长，或用户只要求分析、总结、整理、写方案、起草、润色，都不代表要创建文档。未选择 Room 时必须先调用 context_room_list，禁止猜测 Room。若记忆工具可用且主题不是明确的全新主题，调用前必须先检索相关历史记忆和旧文档并据此客制化正文。调用前先确定准备写入正文的核心内容、重点或结论，再据此拟定能够准确概括正文的具体标题：教程突出学习路径或成果，分析突出对象与核心问题，方案突出目标与行动，报告突出主题与范围。除非用户明确指定必须使用的精确标题，否则不得照抄用户的任务表述，也不得使用“后端学习文档”“项目介绍”“学习资料”等只描述文档形式、没有内容信息的泛标题。成功后从 sequence=1 调用 write_append，最后调用 write_commit。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["create"] },
        title: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "根据即将写入正文的实际核心内容、重点或结论自主提炼的具体标题；标题必须与正文一致，仅在用户明确指定精确标题时照用原文。",
        },
        format: { type: "string", enum: ["markdown"] },
      },
      required: ["mode", "title", "format"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "context_room_write_append",
    title: "流式追加 Room 文档正文",
    description: "按严格连续的 sequence 向文档事务追加新的 Markdown 片段。除非用户明确要求简短版本，否则正文必须是充实、完整的长篇内容：充分展开主题，按需包含背景、核心概念、步骤、例子、注意事项和总结；不得空泛、重复或为了变长而凑字。标题层级应服务于内容结构，默认保持同级章节一致，通常主章节使用 ##、子章节使用 ###，普通强调使用加粗或段落；如果用户明确要求一级标题或其他标题层级，按用户要求输出并保持结构一致。每次只能发送此前未发送的正文，不得用新 sequence 重发累计全文；正文完成后必须调用 write_commit。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        transactionId: { type: "string" },
        sequence: { type: "integer", minimum: 1 },
        text: {
          type: "string",
          description: "仅包含本次新增的 Markdown 正文；标题层级默认保持同级一致，但应遵循用户明确指定的标题层级和排版要求。",
        },
      },
      required: ["transactionId", "sequence", "text"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "context_room_write_commit",
    title: "提交 Room 文档",
    description: "确认正文已经充分展开且内容完整后提交，并生成不可变版本。finalSequence 必须等于最后一个已接收序号。",
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

  constructor(
    private readonly documents: DocumentService,
    private readonly rooms?: DocumentRoomRegistry,
  ) {}

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
        instructions: [
          "Use document tools only when the user explicitly asks to create, save, or write a document in the workspace. Requests to explain, analyze, summarize, organize, plan, draft, polish, expand, or return Markdown should be answered in chat by default and do not authorize document creation. Mentioning a document, being on a document page, or producing a long response is not sufficient intent. If intent is ambiguous, do not call context_room_list or write_begin; answer in chat until the user explicitly asks to persist the result as a document.",
          "Document tools create Markdown documents only in a Context Room bound to this run.",
          "Only if the user explicitly asks to create, save, or write a document and the current viewport has no bound Room, enter Room selection. When both conditions are met, immediately call context_room_list so the client can render the Room selection UI. Do not merely say that creation is unavailable, ask the user to choose without listing Rooms, ask whether they want a list, or require them to type a Room name. For ordinary chat on other pages, do not prompt for Room selection. Do not begin a document until a later run carries the user's explicit selection.",
          "Before calling write_begin, determine the actual core content, emphasis, or conclusion of the body you are about to write, then derive a specific, natural title that accurately summarizes that planned body. Adapt the title to the content type: emphasize the path or outcome for a tutorial, the subject and central question for an analysis, the goal and actions for a plan, and the subject and scope for a report. Unless the user explicitly supplies an exact title, never copy the task wording or use a generic form-only title such as 'Backend Learning Document', 'Project Introduction', or 'Study Notes'. When memory tools are available and the topic is not explicitly new, search relevant memories and prior documents before write_begin and use them to customize the document; skip only for a clearly new topic or when the user says not to use history.",
          "Unless the user explicitly asks for brevity, write a substantial, well-developed long-form document with useful detail, examples, and structure, without repetition or padding.",
          "Keep Markdown heading levels aligned with the requested content structure. By default, keep peer sections at a consistent level, using H2 (##) for top-level sections and H3 (###) for subsections when appropriate, with bold or paragraphs for ordinary emphasis. This is a default, not a hard restriction: if the user explicitly requests H1, another heading level, or specific formatting, follow that request and keep the chosen structure consistent.",
        ].join(" "),
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
    switch (name) {
      case "context_room_list":
        return success({
          rooms: this.rooms?.listReferences() ?? context.availableRooms ?? [],
          selectionRequired: !context.roomId,
          selectedRoomId: context.roomId,
        });
      case "context_room_write_begin": {
        if (!context.roomId) {
          throw new Error("ROOM_SELECTION_REQUIRED: List the available Context Rooms and ask the user to choose one before creating a document");
        }
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
          navigation: {
            pageId: "rooms",
            title: result.document.title,
            action: "created",
            roomId: result.document.roomId,
            objectId: result.document.id,
            objectType: "document",
          },
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
        return success({
          transactionId,
          state: "committed",
          roomId: document.roomId,
          docId: document.id,
          navigation: {
            pageId: "rooms",
            title: document.title,
            action: "created",
            roomId: document.roomId,
            objectId: document.id,
            objectType: "document",
          },
        });
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
