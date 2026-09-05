import type {
  CanonicalAsset,
  CanonicalComment,
  ExternalCommentsStatus,
  ExternalDocumentProvider,
  ExternalDocumentSearchResultItem,
  ExternalDocumentWarning,
} from "@nxcore/agent-contract";
import { ImportConnectorError, type ImportConnectorActionCall } from "./oo-runner.js";

/**
 * 飞书 / Notion 的 OpenConnector 读适配层。只使用 provider 已注册的 action
 * 名（feishu.search_documents / fetch_document / get_document /
 * list_drive_comments，notion.search / retrieve_page / retrieve_page_markdown），
 * 不在业务代码里复制平台 API。上游返回形状随版本变化，全部走防御性解析：
 * 解析不出的条目记 warning 后跳过，绝不用空数组冒充"没有数据"。
 */

export interface ProviderReadResult {
  title: string;
  bodyMarkdown: string;
  sourceUrl: string | null;
  sourceRevision: string | null;
  sourceUpdatedAt: string | null;
  assets: CanonicalAsset[];
  warnings: ExternalDocumentWarning[];
}

export interface ProviderCommentsResult {
  comments: CanonicalComment[];
  status: ExternalCommentsStatus;
  warnings: ExternalDocumentWarning[];
}

export interface ExternalDocumentProviderAdapter {
  provider: ExternalDocumentProvider;
  readonly actionRefs: string[];
  searchDocuments(query: string, signal?: AbortSignal): Promise<{ items: ExternalDocumentSearchResultItem[]; warnings: ExternalDocumentWarning[] }>;
  readDocument(remoteDocumentId: string, signal?: AbortSignal): Promise<ProviderReadResult>;
  readComments(remoteDocumentId: string, signal?: AbortSignal): Promise<ProviderCommentsResult>;
}

/** 单个 OpenConnector action 的执行闭包（生产绑定 oo CLI，测试注入 fake）。 */
export type ImportActionFn = (call: ImportConnectorActionCall, signal?: AbortSignal) => Promise<unknown>;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

const ITEM_ARRAY_KEYS = ["items", "results", "documents", "records", "entities", "data", "list"];

/** 在常见的包裹层级里找结果数组（root 数组 / items / data / data.items …）。 */
function collectRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(objectValue);
  const root = objectValue(value);
  for (const key of ITEM_ARRAY_KEYS) {
    const nested = root[key];
    if (Array.isArray(nested)) return nested.map(objectValue);
    const nestedObject = objectValue(nested);
    for (const innerKey of ITEM_ARRAY_KEYS) {
      if (Array.isArray(nestedObject[innerKey])) {
        return (nestedObject[innerKey] as unknown[]).map(objectValue);
      }
    }
  }
  return [];
}

function firstText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = textValue(record[key]);
    if (value) return value;
  }
  return null;
}

/** Notion 标题属性：properties.title.title[].text.content 等层级。 */
function notionTitle(record: Record<string, unknown>): string | null {
  const properties = objectValue(record.properties);
  for (const key of ["title", "Name", "名称", "标题"]) {
    const property = objectValue(properties[key]);
    const segments = Array.isArray(property.title) ? property.title : [];
    const text = segments
      .map((segment) => textValue(objectValue(segment).text) ?? textValue(objectValue(segment).plain_text))
      .filter(Boolean)
      .join("");
    if (text) return text;
  }
  return firstText(record, ["title", "name"]);
}

const EXTERNAL_IMAGE_PATTERN = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;

/** 从 markdown 中收集外部图片/附件引用；v1 保留原链接不物化。 */
function collectAssets(bodyMarkdown: string): { assets: CanonicalAsset[]; warnings: ExternalDocumentWarning[] } {
  const assets: CanonicalAsset[] = [];
  const warnings: ExternalDocumentWarning[] = [];
  let index = 0;
  for (const match of bodyMarkdown.matchAll(EXTERNAL_IMAGE_PATTERN)) {
    const url = match[1] ?? "";
    assets.push({
      id: `asset-${String(index).padStart(3, "0")}`,
      kind: "image",
      name: null,
      sourceUrl: url,
      contentHash: null,
      mimeType: null,
      bytes: null,
      warning: "asset_not_materialized",
    });
    index += 1;
  }
  if (assets.length > 0) {
    warnings.push({
      code: "assets_kept_as_remote_references",
      message: `${String(assets.length)} 个图片/附件保留远端链接，未下载为本地资源`,
    });
  }
  return { assets, warnings };
}

function mapFeishuSearchItem(record: Record<string, unknown>): ExternalDocumentSearchResultItem | null {
  // OpenConnector 直接透传飞书 Search v2 的 res_units：无独立 id 字段，token 在 url 里。
  const url = firstText(record, ["url", "sourceUrl", "source_url", "webUrl", "web_url", "link"]);
  const remoteDocumentId = firstText(record, [
    "docToken", "doc_token", "objToken", "obj_token", "token", "id", "documentId", "document_id",
  ]) ?? feishuTokenFromUrl(url);
  if (!remoteDocumentId) return null;
  const title = firstText(record, ["title", "displayTitle", "display_title", "name"])
    ?? `未命名文档 ${remoteDocumentId.slice(0, 8)}`;
  return {
    provider: "feishu",
    remoteDocumentId,
    title,
    sourceUrl: url,
    updatedAt: feishuTimestampToIso(firstText(record, [
      "updated_timestamp", "update_timestamp", "updatedTimestamp", "updated_timestamp",
      "updatedAt", "updated_at", "editTime", "edit_time", "update_time",
      "lastModifiedTime", "last_modified_time",
    ])),
    ownerName: firstText(record, ["ownerName", "owner_name", "owner_display_name", "owner", "creator", "owner_id"]),
  };
}

function mapNotionSearchItem(record: Record<string, unknown>): ExternalDocumentSearchResultItem | null {
  const remoteDocumentId = firstText(record, ["id", "pageId", "page_id"]);
  if (!remoteDocumentId) return null;
  const title = notionTitle(record) ?? `Untitled ${remoteDocumentId.slice(0, 8)}`;
  return {
    provider: "notion",
    remoteDocumentId,
    title,
    sourceUrl: firstText(record, ["url", "publicUrl", "public_url"]),
    updatedAt: firstText(record, ["lastEditedTime", "last_edited_time", "lastEditedAt", "last_edited_at", "editedTime"])
      ?? null,
    ownerName: null,
  };
}

function extractMarkdown(value: unknown): string | null {
  const root = objectValue(value);
  // OpenConnector feishu 文档读取的输出形状：{document: {content, title, url, ...}}。
  const document = objectValue(root.document);
  const nested = firstText(document, ["markdown", "content", "text", "body"]);
  if (nested) return nested;
  const direct = firstText(root, ["markdown", "content", "text", "body", "bodyMarkdown"]);
  if (direct) return direct;
  const data = objectValue(root.data);
  return firstText(data, ["markdown", "content", "text", "body"]);
}

/** 从飞书 URL 中提取文档 token（res_units 只有 url，没有独立 id 字段）。 */
function feishuTokenFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = /(?:docx|docs|wiki)\/([A-Za-z0-9]{8,})/.exec(url);
  return match?.[1] ?? null;
}

/** 飞书评论回复正文：content.elements[].text_run.text 拼接。 */
function feishuReplyText(reply: Record<string, unknown>): string {
  const content = objectValue(reply.content);
  const direct = firstText(content, ["text", "content"]);
  if (direct) return direct;
  const elements = Array.isArray(content.elements) ? content.elements : [];
  return elements
    .map((element) => firstText(objectValue(objectValue(element).text_run), ["text"]))
    .filter(Boolean)
    .join("");
}

function feishuTimestampToIso(value: string | null): string | null {
  if (!value) return null;
  // 飞书接口常见毫秒时间戳字符串；秒级（10 位）/毫秒（13 位）/ISO 分别处理。
  if (/^\d{13}$/.test(value)) return new Date(Number(value)).toISOString();
  if (/^\d{10}$/.test(value)) return new Date(Number(value) * 1000).toISOString();
  return value;
}

function feishuComments(value: unknown): ProviderCommentsResult {
  const warnings: ExternalDocumentWarning[] = [];
  const comments: CanonicalComment[] = [];
  let unparsed = 0;
  for (const record of collectRecords(value)) {
    const commentId = firstText(record, ["id", "commentId", "comment_id"]);
    if (!commentId) {
      unparsed += 1;
      continue;
    }
    const solved = record.isSolved === true || record.is_solved === true;
    // 飞书 Drive v1 评论的回复在 reply_list.replies；兼容扁平 replies。
    const replyList = objectValue(record.reply_list);
    const rawReplies = Array.isArray(replyList.replies)
      ? replyList.replies
      : Array.isArray(record.replies) ? record.replies : [];
    const replies = rawReplies.map(objectValue);
    const quote = objectValue(record.quote);
    const quotedText = firstText(quote, ["text", "content", "quote"]) ?? firstText(record, ["quote", "quotedText"]);
    const makeComment = (
      id: string,
      parentId: string | null,
      reply: Record<string, unknown>,
    ): CanonicalComment => {
      const author = objectValue(reply.user).name ?? objectValue(reply.author).name
        ?? firstText(reply, ["user_id", "userId"]);
      return {
        id,
        parentId,
        authorName: textValue(author ?? null),
        body: feishuReplyText(reply) || firstText(reply, ["text", "content"]) || "",
        createdAt: feishuTimestampToIso(firstText(reply, ["created_time", "createTime", "create_time", "createdAt", "created_at"])),
        updatedAt: feishuTimestampToIso(firstText(reply, ["modified_time", "updateTime", "update_time", "updatedAt", "updated_at"])),
        resolved: parentId ? null : solved,
        anchor: quotedText ? { blockId: null, quotedText } : null,
        sourceUrl: null,
        locationStatus: quotedText ? "unlocated" : "unsupported",
      };
    };
    if (replies.length > 0) {
      const [first, ...rest] = replies;
      comments.push(makeComment(commentId, null, first ?? {}));
      for (const reply of rest) {
        const replyId = firstText(reply, ["id", "replyId", "reply_id"]) ?? `${commentId}-r${String(comments.length)}`;
        comments.push(makeComment(replyId, commentId, reply));
      }
    } else {
      comments.push(makeComment(commentId, null, record));
    }
  }
  if (unparsed > 0) {
    warnings.push({ code: "comments_unparsed_items", message: `${String(unparsed)} 条评论无法解析，已跳过` });
  }
  const status: ExternalCommentsStatus = comments.length === 0 && unparsed > 0 ? "partial" : "complete";
  return { comments, status, warnings };
}

export function createFeishuImportAdapter(run: ImportActionFn): ExternalDocumentProviderAdapter {
  return {
  provider: "feishu",
  actionRefs: [
    "feishu.search_documents",
    "feishu.get_document",
    "feishu.fetch_document",
    "feishu.list_drive_comments",
  ],
  async searchDocuments(query) {
    const result = await run({
      service: "feishu",
      action: "search_documents",
      input: { query: query.slice(0, 30), pageSize: 20 },
    });
    const warnings: ExternalDocumentWarning[] = [];
    const items: ExternalDocumentSearchResultItem[] = [];
    let skipped = 0;
    for (const record of collectRecords(result)) {
      const item = mapFeishuSearchItem(record);
      if (item) items.push(item);
      else skipped += 1;
    }
    if (skipped > 0) {
      warnings.push({ code: "search_unparsed_items", message: `${String(skipped)} 条搜索结果无法解析，已跳过` });
    }
    if (items.length === 0 && skipped === 0) {
      warnings.push({ code: "search_empty", message: "搜索没有返回可识别的文档条目" });
    }
    return { items, warnings };
  },
  async readDocument(remoteDocumentId) {
    const warnings: ExternalDocumentWarning[] = [];
    let title: string | null = null;
    let sourceUrl: string | null = null;
    let sourceRevision: string | null = null;
    let sourceUpdatedAt: string | null = null;
    try {
      const meta = objectValue(await run({
        service: "feishu",
        action: "get_document",
        input: { documentId: remoteDocumentId },
      }));
      const data = objectValue(meta.data);
      title = firstText(data, ["title", "name"]) ?? firstText(meta, ["title", "name"]);
      sourceUrl = firstText(data, ["url", "webUrl", "sourceUrl"]) ?? firstText(meta, ["url", "webUrl", "sourceUrl"]);
      sourceRevision = firstText(data, ["revisionId", "revision"]) ?? firstText(meta, ["revisionId", "revision"]);
      sourceUpdatedAt = feishuTimestampToIso(
        firstText(data, ["editTime", "editedTime", "updatedAt"]) ?? firstText(meta, ["editTime", "editedTime", "updatedAt"]),
      );
    } catch (error) {
      // 元数据读取失败不阻断正文导入，落告警。
      warnings.push({
        code: "metadata_read_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const fetchResult = await run({
      service: "feishu",
      action: "fetch_document",
      input: { documentId: remoteDocumentId, format: "markdown" },
    });
    const bodyMarkdown = extractMarkdown(fetchResult);
    if (!bodyMarkdown) {
      throw new ImportConnectorError("cli_error", "feishu.fetch_document 未返回可识别的 Markdown 正文");
    }
    // fetch_document 的 {document:{url,title,revision_id}} 可补齐 get_document 没给的字段。
    const fetched = objectValue(objectValue(fetchResult).document);
    title ??= firstText(fetched, ["title"]);
    sourceUrl ??= firstText(fetched, ["url"]);
    sourceRevision ??= firstText(fetched, ["revision_id", "revisionId"]);
    const { assets, warnings: assetWarnings } = collectAssets(bodyMarkdown);
    warnings.push(...assetWarnings);
    return {
      title: title ?? `未命名文档 ${remoteDocumentId.slice(0, 8)}`,
      bodyMarkdown,
      sourceUrl,
      sourceRevision,
      sourceUpdatedAt,
      assets,
      warnings,
    };
  },
  async readComments(remoteDocumentId) {
    // Drive v1 评论分页：{items, hasMore, pageToken}；上限 5 页防御异常循环。
    const merged = { items: [] as unknown[] };
    const warnings: ExternalDocumentWarning[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = objectValue(await run({
        service: "feishu",
        action: "list_drive_comments",
        input: { fileToken: remoteDocumentId, fileType: "docx", pageSize: 100, ...(pageToken ? { pageToken } : {}) },
      }));
      const items = Array.isArray(result.items) ? result.items : [];
      merged.items.push(...items);
      if (result.hasMore !== true) break;
      const nextToken = textValue(result.pageToken);
      if (!nextToken) break;
      pageToken = nextToken;
      if (page === 4) {
        warnings.push({ code: "comments_pages_capped", message: "评论超过 5 页，仅导入前 5 页" });
      }
    }
    const parsed = feishuComments(merged);
    return { ...parsed, warnings: [...warnings, ...parsed.warnings] };
  },
  };
}

export function createNotionImportAdapter(run: ImportActionFn): ExternalDocumentProviderAdapter {
  return {
  provider: "notion",
  actionRefs: ["notion.search", "notion.retrieve_page", "notion.retrieve_page_markdown"],
  async searchDocuments(query) {
    const result = await run({
      service: "notion",
      action: "search",
      input: { query, page_size: 20 },
    });
    const items: ExternalDocumentSearchResultItem[] = [];
    const warnings: ExternalDocumentWarning[] = [];
    let skipped = 0;
    for (const record of collectRecords(result)) {
      const item = mapNotionSearchItem(record);
      if (item) items.push(item);
      else skipped += 1;
    }
    if (skipped > 0) {
      warnings.push({ code: "search_unparsed_items", message: `${String(skipped)} 条搜索结果无法解析，已跳过` });
    }
    return { items, warnings };
  },
  async readDocument(remoteDocumentId) {
    const warnings: ExternalDocumentWarning[] = [];
    let title: string | null = null;
    let sourceUrl: string | null = null;
    let sourceUpdatedAt: string | null = null;
    try {
      const meta = objectValue(await run({
        service: "notion",
        action: "retrieve_page",
        input: { pageId: remoteDocumentId },
      }));
      const data = objectValue(meta.data);
      title = notionTitle(data) ?? notionTitle(meta);
      sourceUrl = firstText(data, ["url", "publicUrl"]) ?? firstText(meta, ["url", "publicUrl"]);
      sourceUpdatedAt = firstText(data, ["lastEditedTime", "last_edited_time"])
        ?? firstText(meta, ["lastEditedTime", "last_edited_time"]);
    } catch (error) {
      warnings.push({
        code: "metadata_read_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const fetchResult = await run({
      service: "notion",
      action: "retrieve_page_markdown",
      input: { pageId: remoteDocumentId },
    });
    const bodyMarkdown = extractMarkdown(fetchResult);
    if (!bodyMarkdown) {
      throw new ImportConnectorError("cli_error", "notion.retrieve_page_markdown 未返回可识别的 Markdown 正文");
    }
    const { assets, warnings: assetWarnings } = collectAssets(bodyMarkdown);
    warnings.push(...assetWarnings);
    return {
      title: title ?? `Untitled ${remoteDocumentId.slice(0, 8)}`,
      bodyMarkdown,
      sourceUrl,
      sourceRevision: null,
      sourceUpdatedAt,
      assets,
      warnings,
    };
  },
  async readComments() {
    // 上游 notion provider 无评论 action（方案 §5.1 的可降级能力）。
    return {
      comments: [],
      status: "unavailable" as ExternalCommentsStatus,
      warnings: [{
        code: "comments_unsupported_provider",
        message: "Notion 连接器未提供评论读取能力，本次导入不包含评论",
      }],
    };
  },
  };
}

export function importAdapterOf(
  provider: ExternalDocumentProvider,
  run: ImportActionFn,
): ExternalDocumentProviderAdapter {
  return provider === "feishu" ? createFeishuImportAdapter(run) : createNotionImportAdapter(run);
}
