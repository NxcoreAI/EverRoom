import { createHash } from "node:crypto";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import type {
  AgentAccessCapability,
  AgentAccessState,
  AgentAccessStateStatus,
  ResolvedAgentConnection,
} from "./types.js";

/**
 * 对外 MCP 工具的结构化服务依赖（全部为窄接口，测试可替换；
 * 与 channel-mcp-host 的 ChannelMcpTool 同哲学：能力在接口，方法在 Skill）。
 */
export interface AgentAccessToolDeps {
  db: GatewayDatabase;
  search: {
    search(
      query: string,
      filters: { types?: string[] | undefined },
      limit: number,
      offset: number,
    ): {
      items: Array<{
        itemType: string;
        refId: string;
        title: string;
        snippet: string;
        roomIds: string[];
        versionLabel: string | null;
        ingestedAt: string;
        sessionId: string | null;
        status: string;
      }>;
      total: number;
    };
    status?(): unknown;
  } | null;
  documents: {
    get(documentId: string): {
      id: string;
      roomId: string | null;
      title: string;
      version: number;
      deletedAt?: string | null;
    } | null;
    readDocumentForAgent(documentId: string): {
      document: { id: string; roomId: string | null; title: string; version: number };
      blocks: Array<{ blockId: string; type: string; textPreview: string }>;
      markdown: string;
    };
  } | null;
  files: {
    markdownOf(fileId: string): string | null;
    contentOf(fileId: string): Promise<{ buffer: Buffer; mime: string; filename: string } | null>;
  } | null;
  agent: {
    getSnapshot(sessionId: string): {
      session: { id: string; roomId?: string | null; title?: string | null };
      messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
    } | null;
  } | null;
}

export interface AgentAccessTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  /** 工具可见所需能力；数组表示任一即可；"always" 表示任何有效连接可见。 */
  capabilities: AgentAccessCapability[] | "always";
  execute: (args: Record<string, unknown>) => Promise<AgentAccessState>;
}

const MARKDOWN_CHAR_LIMIT = 80_000;
const FILE_BYTES_LIMIT = 5 * 1024 * 1024;

function state<T>(status: AgentAccessStateStatus, data?: T, message?: string): AgentAccessState<T> {
  const result: AgentAccessState<T> = { status };
  if (data !== undefined) result.data = data;
  if (message !== undefined) result.message = message;
  return result;
}

function deepLink(kind: string, id: string): string {
  return `everroom://open/${kind}/${id}`;
}

function hasCapability(connection: ResolvedAgentConnection, capability: AgentAccessCapability): boolean {
  return connection.scopes.capabilities.includes(capability);
}

function noPermission(capability: AgentAccessCapability): AgentAccessState {
  return {
    status: "no_permission",
    requiredCapability: capability,
    message: `本次连接未授予 ${capability} 能力；请在 EverOffice Agent 连接页调整范围，或向用户补问`,
  };
}

function versionState<T extends { version: string }>(
  payload: T,
  basedOnVersion: string | null,
): AgentAccessState<T> {
  if (basedOnVersion !== null && basedOnVersion !== payload.version) {
    return {
      status: "stale",
      latestVersion: payload.version,
      data: payload,
      message: "basedOnVersion 已过期；data 为最新内容，请刷新本地副本后引用",
    };
  }
  return { status: "ok", data: payload };
}

/**
 * Phase 2i：Room 维度已随 5 张 Room 表删除——文件/文档/会话都只在工作区内，
 * 不再按 room_source_memberships 归属过滤（该表已不存在）。
 */
const FETCH_URI_PATTERN =
  /^everroom:\/\/(conversations|documents|files)\/([A-Za-z0-9._:-]+)$/;

type FetchTarget = "conversations" | "documents" | "files";

/** 读五件套 + 自述。按连接闭包构造（capabilities 过滤由 host 做，数据过滤在这里做）。 */
export function createReadTools(
  deps: AgentAccessToolDeps,
  connection: ResolvedAgentConnection,
): AgentAccessTool[] {
  const fetchConversation = (
    sessionId: string,
    args: Record<string, unknown>,
    basedOnVersion: string | null,
  ): AgentAccessState => {
    const snapshot = deps.agent?.getSnapshot(sessionId) ?? null;
    if (!snapshot) return state("source_lost", undefined, "会话不存在或已删除；请换来源或补问用户");
    // 工作区级会话：Phase 2i 起不再按 Room 范围过滤（roomIds 恒无对应房间）。
    const roomId = snapshot.session.roomId ?? null;
    const offset = Math.max(Number(args.offset ?? 0), 0);
    const limit = Math.min(Math.max(Number(args.limit ?? 100), 1), 200);
    const messages = snapshot.messages.slice(offset, offset + limit).map((message) => ({
      messageId: message.id,
      conversationId: sessionId,
      role: message.role,
      content: message.content,
      occurredAt: message.createdAt,
    }));
    const lastMessage = snapshot.messages[snapshot.messages.length - 1];
    return versionState(
      {
        kind: "conversation",
        conversationId: sessionId,
        title: snapshot.session.title ?? null,
        roomId,
        version: lastMessage?.createdAt ?? "empty",
        totalMessages: snapshot.messages.length,
        offset,
        messages,
        nextOffset: offset + messages.length < snapshot.messages.length ? offset + messages.length : null,
        uri: `everroom://conversations/${sessionId}`,
        deepLink: deepLink("conversation", sessionId),
      },
      basedOnVersion,
    );
  };

  const fetchDocument = (documentId: string, basedOnVersion: string | null): AgentAccessState => {
    const document = deps.documents?.get(documentId) ?? null;
    if (!document || document.deletedAt) {
      return state("source_lost", undefined, "文档不存在、已删除或已进回收站");
    }
    let read: ReturnType<NonNullable<AgentAccessToolDeps["documents"]>["readDocumentForAgent"]>;
    try {
      read = deps.documents!.readDocumentForAgent(documentId);
    } catch {
      return state("parse_failed", undefined, "文档正文序列化失败；可改用 everroom_search 的命中片段");
    }
    const truncated = read.markdown.length > MARKDOWN_CHAR_LIMIT;
    return versionState(
      {
        kind: "document",
        documentId,
        roomId: document.roomId,
        title: read.document.title,
        version: `v${read.document.version}`,
        markdown: truncated ? read.markdown.slice(0, MARKDOWN_CHAR_LIMIT) : read.markdown,
        truncated,
        blocks: read.blocks.slice(0, 200).map((block) => ({
          blockId: block.blockId,
          type: block.type,
          preview: block.textPreview,
        })),
        uri: `everroom://documents/${documentId}`,
        deepLink: deepLink("document", documentId),
      },
      basedOnVersion,
    );
  };

  const fetchFile = async (
    fileId: string,
    args: Record<string, unknown>,
  ): Promise<AgentAccessState> => {
    const variant = args.variant === "content" ? "content" : "markdown";
    const loaded = (await deps.files?.contentOf(fileId).catch(() => null)) ?? null;
    if (!loaded) return state("source_lost", undefined, "文件不存在或已删除");
    const contentHash = createHash("sha256").update(loaded.buffer).digest("hex");
    const base = {
      kind: "file",
      fileId,
      filename: loaded.filename,
      mime: loaded.mime,
      byteSize: loaded.buffer.byteLength,
      version: contentHash,
      uri: `everroom://files/${fileId}`,
      deepLink: deepLink("file", fileId),
    };
    if (variant === "content") {
      if (loaded.buffer.byteLength > FILE_BYTES_LIMIT) {
        return state("invalid_input", base, `文件超过 ${FILE_BYTES_LIMIT} 字节上限；请用 markdown 变体`);
      }
      return state("ok", { ...base, contentBase64: loaded.buffer.toString("base64") });
    }
    const markdown = deps.files?.markdownOf(fileId) ?? null;
    if (markdown === null) {
      return state("parse_failed", base, "该文件类型暂无 markdown 正文；可改用 content 变体取原始字节");
    }
    const truncated = markdown.length > MARKDOWN_CHAR_LIMIT;
    return state("ok", {
      ...base,
      markdown: truncated ? markdown.slice(0, MARKDOWN_CHAR_LIMIT) : markdown,
      truncated,
    });
  };

  const capabilityByTarget: Record<FetchTarget, AgentAccessCapability> = {
    conversations: "read_conversations",
    documents: "read_documents",
    files: "read_files",
  };

  const fetchTool: AgentAccessTool = {
    name: "everroom_fetch",
    title: "按 URI 精读",
    description:
      "精读 everroom:// URI 指向的原文：会话消息（分页）、文档（markdown+块锚点）与文件。可传 basedOnVersion 校验副本新鲜度：版本过期时返回 stale 并附最新版本，内容仍随 data 返回（未刷新的副本可见）。",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", pattern: "^everroom://", maxLength: 300 },
        basedOnVersion: { type: "string", maxLength: 128 },
        offset: { type: "integer", minimum: 0, maximum: 100000 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        variant: { type: "string", enum: ["markdown", "content"] },
      },
      required: ["uri"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    capabilities: ["read_conversations", "read_documents", "read_files", "search"],
    execute: async (args) => {
      const match = FETCH_URI_PATTERN.exec(String(args.uri ?? ""));
      if (!match) {
        return state("invalid_input", undefined, "uri 无法解析；合法形如 everroom://conversations/{sessionId}");
      }
      const target = match[1] as FetchTarget;
      const id = match[2]!;
      const basedOnVersion = args.basedOnVersion === undefined ? null : String(args.basedOnVersion);
      if (!hasCapability(connection, capabilityByTarget[target])) {
        return noPermission(capabilityByTarget[target]);
      }
      if (target === "conversations") return fetchConversation(id, args, basedOnVersion);
      if (target === "documents") return fetchDocument(id, basedOnVersion);
      return await fetchFile(id, args);
    },
  };

  const searchTool: AgentAccessTool = {
    name: "everroom_search",
    title: "跨类型搜索",
    description:
      "搜索 EverOffice 积累：会话消息、文档与文件。每个命中带稳定对象 ID、版本、everroom:// URI 与精读入口；会话命中含 conversationId 与 messageId，用 everroom_fetch 继续精读原文。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["conversation", "document", "file", "artifact"] },
          maxItems: 4,
        },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        offset: { type: "integer", minimum: 0, maximum: 10000 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    capabilities: ["search"],
    execute: async (args) => {
      const query = String(args.query ?? "").trim();
      const kinds = Array.isArray(args.kinds) && args.kinds.length > 0
        ? (args.kinds as string[])
        : ["conversation", "document", "file", "artifact"];
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 50);
      const offset = Math.max(Number(args.offset ?? 0), 0);

      const hits: Array<Record<string, unknown>> = [];
      const typeByKind: Record<string, string> = {
        conversation: "message",
        document: "document",
        file: "file",
        artifact: "export",
      };
      const ftsKinds = kinds.filter((kind) => typeByKind[kind]);
      if (deps.search && ftsKinds.length > 0) {
        const page = deps.search.search(
          query,
          { types: ftsKinds.map((kind) => typeByKind[kind]!) },
          limit,
          offset,
        );
        // 搜索命中的 uri 必须与 everroom_fetch 的解析方案一致（documents/files 复数段）。
        const uriSegmentByType: Record<string, string> = {
          document: "documents",
          file: "files",
        };
        hits.push(
          ...page.items.map((item) => {
            const kind = item.itemType === "message"
              ? "conversation"
              : item.itemType === "export"
                ? "artifact"
                : item.itemType;
            const isMessage = item.itemType === "message" && item.sessionId;
            const uri = isMessage
              ? `everroom://conversations/${item.sessionId}`
              : `everroom://${uriSegmentByType[item.itemType] ?? item.itemType}/${item.refId}`;
            return {
              kind,
              objectId: item.refId,
              title: item.title,
              snippet: item.snippet,
              roomIds: item.roomIds,
              version: item.versionLabel,
              updatedAt: item.ingestedAt,
              indexed: item.status === "indexed",
              uri,
              ...(isMessage ? { conversationId: item.sessionId, messageId: item.refId } : {}),
              deepLink: isMessage
                ? deepLink("conversation", item.sessionId!)
                : deepLink(kind, item.refId),
            };
          }),
        );
      }
      return hits.length === 0
        ? state("empty", { hits: [], query }, "没有匹配结果；可换关键词、放宽类型或补问用户")
        : state("ok", { hits, query, limit, offset });
    },
  };

  const readFileTool: AgentAccessTool = {
    name: "everroom_read_file",
    title: "读取源文件",
    description:
      "读取源文件原文（markdown 或 base64 内容），带 sha256 内容指纹与版本。搜索命中的文件可用此工具继续读原文。",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", minLength: 1, maxLength: 200 },
        variant: { type: "string", enum: ["markdown", "content"] },
      },
      required: ["fileId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    capabilities: ["read_files"],
    execute: async (args) => {
      const fileId = String(args.fileId ?? "");
      const result = await fetchFile(fileId, args);
      if (result.status === "no_permission") return noPermission("read_files");
      return result;
    },
  };

  const getRulesTool: AgentAccessTool = {
    name: "everroom_get_rules",
    title: "获取本次规则",
    description:
      "获取本次任务适用的规则：连接授权范围摘要。统一技能/偏好/模板库上线后返回完整规则集。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    capabilities: ["read_rules"],
    execute: async () => state("ok", {
      scope: {
        roomIds: connection.scopes.roomIds,
        capabilities: connection.scopes.capabilities,
        writebackRoomId: connection.scopes.writebackRoomId,
      },
      rules: [],
      note: "统一技能/偏好/模板库（PRD 6.7）上线后，本工具将返回完整规则集（触发场景、优先级、参考资源）",
    }),
  };

  const getStatusTool: AgentAccessTool = {
    name: "everroom_get_status",
    title: "连接与能力自述",
    description:
      "返回连接信息、各服务可用性（搜索索引）与授权范围。遇到失败先调用本工具判断是能力未开还是服务暂不可用，避免盲目重试。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    capabilities: "always",
    execute: async () => {
      return state("ok", {
        connection: {
          name: connection.name,
          tool: connection.tool,
          capabilities: connection.scopes.capabilities,
          roomIds: connection.scopes.roomIds,
          writebackRoomId: connection.scopes.writebackRoomId,
        },
        services: {
          search: deps.search
            ? { available: true, status: deps.search.status?.() ?? null }
            : { available: false },
          documents: deps.documents ? { available: true } : { available: false },
          files: deps.files ? { available: true } : { available: false },
        },
      });
    },
  };

  return [searchTool, fetchTool, readFileTool, getRulesTool, getStatusTool];
}
