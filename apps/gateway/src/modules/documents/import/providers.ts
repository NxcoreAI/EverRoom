import type {
  CanonicalAsset,
  CanonicalComment,
  ExternalCommentsStatus,
  ExternalDocumentListItem,
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

export interface ProviderListResult {
  items: ExternalDocumentListItem[];
  truncated: boolean;
  warnings: ExternalDocumentWarning[];
}

export interface ExternalDocumentProviderAdapter {
  provider: ExternalDocumentProvider;
  readonly actionRefs: string[];
  searchDocuments(query: string, signal?: AbortSignal): Promise<{ items: ExternalDocumentSearchResultItem[]; warnings: ExternalDocumentWarning[] }>;
  readDocument(remoteDocumentId: string, signal?: AbortSignal): Promise<ProviderReadResult>;
  readComments(remoteDocumentId: string, signal?: AbortSignal): Promise<ProviderCommentsResult>;
  /** 按连接全量列举可导入文档（连接器页批量导入入口）；imported 标记由 service 回填。 */
  listAllDocuments(signal?: AbortSignal): Promise<ProviderListResult>;
}

/** 单个 OpenConnector action 的执行闭包（生产绑定运行时 HTTP，测试注入 fake）。 */
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

// ── 按连接全量列举（连接器页批量导入）──────────────────────────────────────
// 上限防御：列举走真实翻页/递归，异常大的工作区靠硬上限截断并以 truncated
// 明示，绝不静默丢弃。上限值见常量；wiki 文档的 remoteDocumentId 必须用
// obj_token（与 readDocument 的 get_document/fetch_document(documentId) 同链路）。

const LIST_MAX_DOCUMENTS = 500;
const LIST_DRIVE_MAX_DEPTH = 5;
const LIST_DRIVE_PAGES_PER_LEVEL = 5;
const LIST_DRIVE_PAGE_SIZE = 200;
const LIST_WIKI_MAX_SPACES = 10;
const LIST_WIKI_PAGE_SIZE = 50;
const LIST_NOTION_PAGE_SIZE = 100;
const LIST_NOTION_MAX_PAGES = 10;

interface ListingState {
  byId: Map<string, ExternalDocumentListItem>;
  truncated: boolean;
  warnings: ExternalDocumentWarning[];
}

function listingPush(state: ListingState, item: ExternalDocumentListItem): void {
  if (state.byId.has(item.remoteDocumentId)) return;
  if (state.byId.size >= LIST_MAX_DOCUMENTS) {
    state.truncated = true;
    return;
  }
  state.byId.set(item.remoteDocumentId, item);
}

async function feishuListDrive(run: ImportActionFn, state: ListingState, signal?: AbortSignal): Promise<void> {
  const visited = new Set<string>();
  let queue: Array<{ token: string | null; depth: number }> = [{ token: null, depth: 0 }];
  while (queue.length > 0 && !state.truncated) {
    const level = queue;
    queue = [];
    for (const folder of level) {
      if (folder.depth > LIST_DRIVE_MAX_DEPTH || (folder.token && visited.has(folder.token))) continue;
      if (folder.token) visited.add(folder.token);
      let pageToken: string | null = null;
      for (let page = 0; page < LIST_DRIVE_PAGES_PER_LEVEL; page += 1) {
        signal?.throwIfAborted();
        const result = objectValue(await run({
          service: "feishu",
          action: "list_drive_files",
          input: {
            pageSize: LIST_DRIVE_PAGE_SIZE,
            ...(folder.token ? { folderToken: folder.token } : {}),
            ...(pageToken ? { pageToken } : {}),
          },
        }, signal));
        const files = Array.isArray(result.items) ? result.items.map(objectValue) : [];
        for (const file of files) {
          const type = firstText(file, ["type"]);
          const token = firstText(file, ["token"]);
          if (type === "folder" && token) {
            queue.push({ token, depth: folder.depth + 1 });
          } else if (type === "docx" && token) {
            listingPush(state, {
              provider: "feishu",
              remoteDocumentId: token,
              title: firstText(file, ["name", "title"]) ?? `未命名文档 ${token.slice(0, 8)}`,
              sourceUrl: firstText(file, ["url"]),
              updatedAt: feishuTimestampToIso(firstText(file, ["modified_time", "edited_time", "update_time"])),
              ownerName: firstText(file, ["owner_display_name", "ownerName", "owner_name"]),
              origin: "drive",
              wikiSpaceName: null,
              imported: false,
            });
          }
        }
        pageToken = pageTokenOf(result);
        if (result.hasMore !== true || !pageToken || state.truncated) break;
      }
    }
  }
}

function pageTokenOf(value: Record<string, unknown>): string | null {
  return firstText(value, ["pageToken", "page_token"]);
}

async function feishuListWiki(run: ImportActionFn, state: ListingState, signal?: AbortSignal): Promise<void> {
  const spaces: Array<{ spaceId: string; name: string | null }> = [];
  let spacesPageToken: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    signal?.throwIfAborted();
    const result = objectValue(await run({
      service: "feishu",
      action: "list_wiki_spaces",
      input: { pageSize: LIST_WIKI_PAGE_SIZE, ...(spacesPageToken ? { pageToken: spacesPageToken } : {}) },
    }, signal));
    for (const space of Array.isArray(result.items) ? result.items.map(objectValue) : []) {
      const spaceId = firstText(space, ["space_id", "spaceId"]);
      if (spaceId) spaces.push({ spaceId, name: firstText(space, ["name", "title"]) });
    }
    spacesPageToken = pageTokenOf(result);
    if (result.hasMore !== true || !spacesPageToken) break;
  }
  if (spacesPageToken || spaces.length > LIST_WIKI_MAX_SPACES) {
    state.truncated = true;
    state.warnings.push({
      code: "list_truncated",
      message: `知识库空间超过 ${String(LIST_WIKI_MAX_SPACES)} 个，仅列举前 ${String(LIST_WIKI_MAX_SPACES)} 个`,
    });
  }
  const visitNode = async (space: { spaceId: string; name: string | null }, parentNodeToken: string | null, depth: number): Promise<void> => {
    if (depth > LIST_DRIVE_MAX_DEPTH || state.truncated) return;
    let pageToken: string | null = null;
    for (let page = 0; page < LIST_DRIVE_PAGES_PER_LEVEL; page += 1) {
      signal?.throwIfAborted();
      const result = objectValue(await run({
        service: "feishu",
        action: "list_wiki_nodes",
        input: {
          spaceId: space.spaceId,
          pageSize: LIST_WIKI_PAGE_SIZE,
          ...(parentNodeToken ? { parentNodeToken } : {}),
          ...(pageToken ? { pageToken } : {}),
        },
      }, signal));
      for (const node of Array.isArray(result.items) ? result.items.map(objectValue) : []) {
        const objToken = firstText(node, ["obj_token", "objToken"]);
        const nodeToken = firstText(node, ["node_token", "nodeToken"]);
        if (firstText(node, ["obj_type", "objType"]) === "docx" && objToken) {
          listingPush(state, {
            provider: "feishu",
            remoteDocumentId: objToken,
            title: firstText(node, ["title"]) ?? `未命名文档 ${objToken.slice(0, 8)}`,
            sourceUrl: null,
            updatedAt: feishuTimestampToIso(firstText(node, ["obj_edit_time", "obj_create_time", "edited_time"])),
            ownerName: null,
            origin: "wiki",
            wikiSpaceName: space.name,
            imported: false,
          });
        }
        if (node.has_child === true && nodeToken) {
          await visitNode(space, nodeToken, depth + 1);
        }
      }
      pageToken = pageTokenOf(result);
      if (result.hasMore !== true || !pageToken || state.truncated) break;
    }
  };
  for (const space of spaces.slice(0, LIST_WIKI_MAX_SPACES)) {
    if (state.truncated) break;
    await visitNode(space, null, 0);
  }
}

async function notionListPages(run: ImportActionFn, state: ListingState, signal?: AbortSignal): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < LIST_NOTION_MAX_PAGES; page += 1) {
    signal?.throwIfAborted();
    const result = objectValue(await run({
      service: "notion",
      action: "search",
      input: {
        query: "",
        filter: { property: "object", value: "page" },
        pageSize: LIST_NOTION_PAGE_SIZE,
        ...(cursor ? { startCursor: cursor } : {}),
      },
    }, signal));
    let unparsed = 0;
    for (const record of collectRecords(result)) {
      const mapped = mapNotionSearchItem(record);
      if (mapped) {
        listingPush(state, {
          provider: "notion",
          remoteDocumentId: mapped.remoteDocumentId,
          title: mapped.title,
          sourceUrl: mapped.sourceUrl,
          updatedAt: mapped.updatedAt,
          ownerName: mapped.ownerName,
          origin: "page",
          wikiSpaceName: null,
          imported: false,
        });
      } else {
        unparsed += 1;
      }
    }
    if (unparsed > 0) {
      state.warnings.push({ code: "list_unparsed_items", message: `${String(unparsed)} 条页面无法解析，已跳过` });
    }
    cursor = firstText(result, ["next_cursor", "nextCursor"]);
    if (result.has_more !== true || !cursor) return;
    if (state.truncated) return;
    if (page === LIST_NOTION_MAX_PAGES - 1) {
      state.truncated = true;
      state.warnings.push({
        code: "list_truncated",
        message: `页面超过 ${String(LIST_NOTION_MAX_PAGES * LIST_NOTION_PAGE_SIZE)} 条，仅列举前 ${String(LIST_NOTION_MAX_PAGES * LIST_NOTION_PAGE_SIZE)} 条`,
      });
    }
  }
}

export function createFeishuImportAdapter(run: ImportActionFn): ExternalDocumentProviderAdapter {
  return {
  provider: "feishu",
  actionRefs: [
    "feishu.search_documents",
    "feishu.get_document",
    "feishu.fetch_document",
    "feishu.list_drive_comments",
    "feishu.list_drive_files",
    "feishu.list_wiki_spaces",
    "feishu.list_wiki_nodes",
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
      throw new ImportConnectorError("connector_error", "feishu.fetch_document 未返回可识别的 Markdown 正文");
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
  async listAllDocuments(signal) {
    const state: ListingState = { byId: new Map(), truncated: false, warnings: [] };
    // 云空间先列（根目录递归），wiki 空间树随后；同 token 以 drive 记录优先。
    await feishuListDrive(run, state, signal);
    await feishuListWiki(run, state, signal);
    if (state.truncated) {
      state.warnings.push({
        code: "list_truncated",
        message: `文档超过 ${String(LIST_MAX_DOCUMENTS)} 篇，仅列举前 ${String(LIST_MAX_DOCUMENTS)} 篇`,
      });
    }
    return { items: [...state.byId.values()], truncated: state.truncated, warnings: state.warnings };
  },
  };
}

/** 富文本数组拍平成纯文本（rich_text[].text.content / plain_text 多形状兼容）。 */
function notionRichTextText(value: unknown): string {
  const items = Array.isArray(value) ? value.map(objectValue) : [];
  return items
    .map((item) => firstText(item, ["plain_text"]) ?? firstText(objectValue(item.text), ["content"]))
    .filter(Boolean)
    .join("")
    .trim();
}

/**
 * Notion list_page_comments 结果 → CanonicalComment。防御性解析：
 * - 正文：body.paragraph.rich_text / body.rich_text / text.title 多版本形状；
 * - 线程：discussion_id 分组，同组最早一条为父，其余为回复；
 * - 锚点：parent.block_id 保留 blockId；无引用文本，一律未定位（面板"未定位评论"区）；
 * - resolved：Notion 不暴露解决状态，置 null（unknown）。
 */
function notionComments(raw: Record<string, unknown>[], warnings: ExternalDocumentWarning[]): ProviderCommentsResult {
  const parsed: Array<{ id: string; discussionId: string | null; comment: CanonicalComment }> = [];
  let unparsed = 0;
  for (const record of raw) {
    const id = firstText(record, ["id"]);
    const commentBody = objectValue(record.body);
    const commentText = objectValue(record.text);
    const body = notionRichTextText(objectValue(commentBody.paragraph).rich_text)
      || notionRichTextText(commentBody.rich_text)
      || notionRichTextText(commentText.title)
      || notionRichTextText(record.text);
    if (!id || !body) {
      unparsed += 1;
      continue;
    }
    const createdBy = objectValue(record.created_by);
    const blockId = firstText(objectValue(record.parent), ["block_id"]);
    parsed.push({
      id,
      discussionId: firstText(record, ["discussion_id", "discussionId"]),
      comment: {
        id,
        parentId: null,
        authorName: firstText(createdBy, ["name"]),
        body,
        createdAt: firstText(record, ["created_time", "createdTime"]),
        updatedAt: firstText(record, ["last_edited_time", "lastEditedTime"]),
        resolved: null,
        anchor: blockId ? { blockId, quotedText: null } : null,
        sourceUrl: null,
        locationStatus: "unlocated",
      },
    });
  }
  const threadRoot = new Map<string, string>();
  for (const item of parsed) {
    if (!item.discussionId || threadRoot.has(item.discussionId)) continue;
    threadRoot.set(item.discussionId, item.id);
  }
  const comments: CanonicalComment[] = parsed.map((item) => item.comment);
  for (const item of parsed) {
    if (!item.discussionId) continue;
    const rootId = threadRoot.get(item.discussionId);
    if (rootId && rootId !== item.id) item.comment.parentId = rootId;
  }
  if (unparsed > 0) {
    warnings.push({ code: "comments_unparsed_items", message: `${String(unparsed)} 条 Notion 评论无法解析，已跳过` });
  }
  const status: ExternalCommentsStatus = comments.length === 0 && unparsed > 0 ? "partial" : "complete";
  return { comments, status, warnings };
}

export function createNotionImportAdapter(run: ImportActionFn): ExternalDocumentProviderAdapter {
  return {
  provider: "notion",
  actionRefs: ["notion.search", "notion.retrieve_page", "notion.retrieve_page_markdown", "notion.list_page_comments"],
  async searchDocuments(query) {
    const result = await run({
      service: "notion",
      action: "search",
      // 上游 schema 字段是 pageSize（驼峰）；page_size 会被严格校验拒绝。
      input: { query, pageSize: 20 },
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
      throw new ImportConnectorError("connector_error", "notion.retrieve_page_markdown 未返回可识别的 Markdown 正文");
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
  async readComments(remoteDocumentId, signal) {
    // 上游已注册 notion.list_page_comments（read_content scope；分页
    // startCursor ≤5 页防御）。Notion API 不暴露 resolved 状态 → null。
    const raw: Record<string, unknown>[] = [];
    const warnings: ExternalDocumentWarning[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      signal?.throwIfAborted();
      const result = objectValue(await run({
        service: "notion",
        action: "list_page_comments",
        input: {
          pageId: remoteDocumentId,
          pageSize: 100,
          ...(cursor ? { startCursor: cursor } : {}),
        },
      }, signal));
      for (const item of Array.isArray(result.results) ? result.results.map(objectValue) : []) raw.push(item);
      if (result.has_more !== true) break;
      const next = firstText(result, ["next_cursor", "nextCursor"]);
      if (!next) break;
      cursor = next;
    }
    return notionComments(raw, warnings);
  },
  async listAllDocuments(signal) {
    // 空 query 全量列举（仅覆盖已共享给该连接的页面）；结果为空时明示范围提示。
    const state: ListingState = { byId: new Map(), truncated: false, warnings: [] };
    await notionListPages(run, state, signal);
    if (state.byId.size === 0) {
      state.warnings.push({
        code: "list_empty_scope_hint",
        message: "未列出任何页面：Notion 连接只能看到已共享给该连接的页面",
      });
    }
    return { items: [...state.byId.values()], truncated: state.truncated, warnings: state.warnings };
  },
  };
}

export function importAdapterOf(
  provider: ExternalDocumentProvider,
  run: ImportActionFn,
): ExternalDocumentProviderAdapter {
  return provider === "feishu" ? createFeishuImportAdapter(run) : createNotionImportAdapter(run);
}
