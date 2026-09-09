import { randomUUID } from "node:crypto";
import { diffChars } from "diff";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type {
  CanonicalComment,
  CanonicalDocumentArtifact,
  DocumentDiffResult,
  DocumentImportCommentDiffSummary,
  ExternalDocumentCommentView,
  ExternalDocumentListItem,
  ExternalDocumentListResponse,
  DocumentImportHistoryEntry,
  DocumentImportRunView,
  ExternalDocumentPreview,
  ExternalDocumentProvider,
  ExternalDocumentSearchResponse,
  ExternalDocumentWarning,
  RoomDocument,
  TiptapJsonContent,
} from "@nxcore/agent-contract";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import {
  documentImportComments,
  documentImportListCache,
  documentImportRuns,
  documentImportSnapshots,
  documentImportSources,
  documentRoomImports,
  documents,
} from "../../../infrastructure/database/schema.js";
import type { OpenConnectorCliConfig } from "../../../config.js";
import { agentDocumentMarkdown } from "../agent-markdown.js";
import type { DocumentService } from "../service.js";
import { artifactHashOf, readArtifact, storeArtifact } from "./artifact-store.js";
import { ImportConnectorError, runImportConnectorAction, type ImportActionRunner } from "./oo-runner.js";
import { importAdapterOf, type ExternalDocumentProviderAdapter, type ImportActionFn } from "./providers.js";
import { runNtnCli, type NtnCliConfig } from "../agent-export/ntn-cli.js";

export class ImportServiceError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, statusCode = 400, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface CommitImportInput {
  runId: string;
  roomId: string;
  /** 提供时表示"同一来源再次导入到该文档"：生成候选版本，不覆盖当前文档。 */
  targetDocumentId?: string;
  /** true：跳过来源去重——同来源在该 Room 已有文档时仍新建（用户明确选"创建新的"）。 */
  forceNewDocument?: boolean;
}

export interface CommitImportResult {
  run: DocumentImportRunView;
  roomImportId: string | null;
  /** primary：新建文档版本 1；candidate：物化候选文档，待用户应用。 */
  relation: "primary" | "candidate";
  /** 远端内容与该文档最近一次已应用快照相同：未创建任何记录（防空候选堆积）。 */
  noChange?: boolean;
  documentId: string;
  document: RoomDocument;
}

function objectValueish(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 图片魔数嗅探：返回真实格式（远端 content-type 声明不可信）。 */
function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

function isoToDateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Notion 行内评论标记（含 markdown 转义形态）。URL 各段含 page/discussion/
 * comment id；线程根评论的 id 即 discussion id，故按"id 是否出现在 url 集"匹配，
 * 回复经 parentId 继承同一锚点。 */
const DISCUSSION_SPAN_PATTERN = /\\?<span\s+discussion-urls="([^"]*)"\s*\\?>([\s\S]*?)\\?<\/span\s*\\?>/g;

function anchorDiscussionSpans(markdown: string, comments: CanonicalComment[]): {
  markdown: string;
  comments: CanonicalComment[];
} {
  // 剥离与评论无关：标记不该以字面进编辑器（即使评论列表为空，如已解决
  // 的评论 Notion API 不返回但 span 仍在正文里）。
  if (!/<span\s+discussion-urls/i.test(markdown.replace(/\\/g, ""))) {
    return { markdown, comments };
  }
  const quotes: Array<{ ids: Set<string>; text: string }> = [];
  const cleaned = markdown.replace(DISCUSSION_SPAN_PATTERN, (_match, urls: string, text: string) => {
    const ids = new Set(String(urls).split(/[\s/]+/).filter((part) => part.length >= 4 && !part.endsWith(":")));
    const trimmed = String(text).trim();
    if (trimmed) quotes.push({ ids, text: trimmed });
    return String(text);
  });
  if (quotes.length === 0) return { markdown, comments };
  const byParent = new Map<string, CanonicalComment[]>();
  for (const comment of comments) {
    if (!comment.parentId) continue;
    const group = byParent.get(comment.parentId);
    if (group) group.push(comment);
    else byParent.set(comment.parentId, [comment]);
  }
  const applyAnchor = (comment: CanonicalComment, text: string): void => {
    if (comment.anchor?.quotedText) return;
    comment.anchor = { blockId: comment.anchor?.blockId ?? null, quotedText: text };
    comment.locationStatus = "located";
    for (const reply of byParent.get(comment.id) ?? []) applyAnchor(reply, text);
  };
  for (const comment of comments) {
    const hit = quotes.find((quote) => quote.ids.has(comment.id));
    if (hit) applyAnchor(comment, hit.text);
  }
  return { markdown: cleaned, comments };
}

const CONTAINER_BLOCK_TYPES = new Set(["orderedList", "bulletList", "table"]);

function textOfDiffNode(node: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") parts.push(record.text);
    if (Array.isArray(record.content)) record.content.forEach(walk);
  };
  walk(node);
  return parts.join("");
}

function childKeyOf(node: Record<string, unknown>): string {
  return `${String(node.type ?? "")}\u0000${textOfDiffNode(node)}`;
}

function charSpansOf(before: string, after: string): Array<{ type: "equal" | "insert" | "delete"; text: string }> {
  return diffChars(before, after).map((part) => ({
    type: part.added ? "insert" as const : part.removed ? "delete" as const : "equal" as const,
    text: part.value,
  })).filter((span) => span.text.length > 0);
}

/**
 * 容器块细化（候选 diff 专用）：顶层列表/表格是单个 diff 单位——一项/一格
 * 的改动会被渲染成整块"删除+新增"。这里把 modified 容器按子块（列表项/
 * 表格行）做 LCS：变更的子块独立成块（外面包一层同类型容器保证渲染器可
 * 序列化），未变的子块直接省略。unchanged 容器不受影响。
 */
function refineContainerDiff(diff: DocumentDiffResult): DocumentDiffResult {
  if (!diff.blocks.some((block) => block.status === "modified"
    && CONTAINER_BLOCK_TYPES.has(block.type) && block.before && block.after)) {
    return diff;
  }
  const out: DocumentDiffResult["blocks"] = [];
  for (const block of diff.blocks) {
    if (block.status !== "modified" || !block.before || !block.after) {
      // 文本级零差异的 modified（嵌套属性/结构噪声）：降级，避免渲染整块增删。
      if (block.status === "modified"
        && block.textDiff.every((span) => span.type === "equal" || span.text.length === 0)) {
        const { before: noiseBefore, ...noiseRest } = block;
        void noiseBefore;
        out.push({ ...noiseRest, status: "unchanged", after: (block.after ?? block.before) as TiptapJsonContent });
      } else {
        out.push(block);
      }
      continue;
    }
    if (!CONTAINER_BLOCK_TYPES.has(block.type)) {
      out.push(block);
      continue;
    }
    const beforeNode = block.before as unknown as Record<string, unknown>;
    const afterNode = block.after as unknown as Record<string, unknown>;
    const beforeChildren = Array.isArray(beforeNode.content)
      ? (beforeNode.content as Array<Record<string, unknown>>) : [];
    const afterChildren = Array.isArray(afterNode.content)
      ? (afterNode.content as Array<Record<string, unknown>>) : [];
    // 子块 LCS（type+text 为键）：复用块对齐思路，O(n·m) 对列表/表格规模足够。
    const beforeKeys = beforeChildren.map(childKeyOf);
    const afterKeys = afterChildren.map(childKeyOf);
    const width = afterChildren.length + 1;
    const table: number[][] = Array.from({ length: beforeChildren.length + 1 }, () => new Array<number>(width).fill(0));
    for (let i = beforeChildren.length - 1; i >= 0; i -= 1) {
      for (let j = afterChildren.length - 1; j >= 0; j -= 1) {
        table[i]![j]! = beforeKeys[i] === afterKeys[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    const pairs: Array<{ before: number; after: number }> = [];
    let i = 0;
    let j = 0;
    while (i < beforeChildren.length && j < afterChildren.length) {
      if (beforeKeys[i] === afterKeys[j]) {
        pairs.push({ before: i, after: j });
        i += 1; j += 1;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
      else j += 1;
    }
    const matchedBefore = new Set(pairs.map((pair) => pair.before));
    const matchedAfter = new Set(pairs.map((pair) => pair.after));
    const emit = (status: "added" | "removed" | "modified",
      beforeChild: Record<string, unknown> | null,
      afterChild: Record<string, unknown> | null,
      ordinal: number): void => {
      const wrap = (child: Record<string, unknown> | null) => child
        ? { type: block.type, content: [child] } as unknown as TiptapJsonContent : undefined;
      const beforeNode = wrap(beforeChild);
      const afterNode = wrap(afterChild);
      out.push({
        blockId: `${block.blockId}:${String(ordinal)}`,
        status,
        type: block.type,
        path: [...block.path, ordinal],
        ...(beforeNode ? { before: beforeNode } : {}),
        ...(afterNode ? { after: afterNode } : {}),
        textDiff: charSpansOf(
          beforeChild ? textOfDiffNode(beforeChild) : "",
          afterChild ? textOfDiffNode(afterChild) : "",
        ),
        unstableMatch: true,
      });
    };
    let emitted = 0;
    for (const pair of pairs) {
      const beforeChild = beforeChildren[pair.before]!;
      const afterChild = afterChildren[pair.after]!;
      if (beforeKeys[pair.before] === afterKeys[pair.after]) continue;
      emit("modified", beforeChild, afterChild, emitted);
      emitted += 1;
    }
    beforeChildren.forEach((child, index) => {
      if (!matchedBefore.has(index)) {
        emit("removed", child, null, emitted);
        emitted += 1;
      }
    });
    afterChildren.forEach((child, index) => {
      if (!matchedAfter.has(index)) {
        emit("added", null, child, emitted);
        emitted += 1;
      }
    });
    if (emitted === 0) {
      // 全部子块文本一致：差异只是嵌套 id/属性噪声（候选重导入会重新生成
      // 所有嵌套 UUID），降级为 unchanged——整块"删除+新增"是纯视觉噪声。
      const { before: dropBefore, ...dropRest } = block;
      void dropBefore;
      out.push({ ...dropRest, status: "unchanged", after: (block.after ?? block.before) as TiptapJsonContent });
    }
  }
  return { ...diff, blocks: out };
}

/** 从讨论标记 URL 提取 blockId（结构：discussion://{pageId}/{blockId}/{discussionId}，
 * 真机核实第二段即评论父块 id）。用于行内评论按块查询。 */
function discussionSpanBlockIds(markdown: string): Array<{ blockId: string; text: string }> {
  const found: Array<{ blockId: string; text: string }> = [];
  const seen = new Set<string>();
  const unescaped = markdown.replace(/\\/g, "");
  const pattern = /<span\s+discussion-urls="([^"]*)"\s*>([\s\S]*?)<\/span\s*>/g;
  for (const match of unescaped.matchAll(pattern)) {
    // 结构：discussion://{pageId}/{blockId}/{discussionId}；先滤掉 scheme 段。
    const parts = String(match[1]).split(/[\s/]+/).filter((part) => part && !part.endsWith(":"));
    const blockId = parts[1];
    const text = String(match[2] ?? "").trim();
    if (!blockId || blockId.length < 8 || seen.has(blockId) || !text) continue;
    seen.add(blockId);
    found.push({ blockId, text });
  }
  return found;
}

/** ntn v1/comments 结果（新版顶层 rich_text 形状）→ CanonicalComment，按
 * discussion_id 分组（最早为根）并直接落锚点（quotedText=span 文本）。 */
function notionInlineCommentsOf(
  raw: Array<Record<string, unknown>>,
  anchorsByBlock: Map<string, string>,
): CanonicalComment[] {
  const parsed: Array<{ id: string; discussionId: string | null; createdAt: number; comment: CanonicalComment }> = [];
  for (const record of raw) {
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
    const richText = Array.isArray(record.rich_text) ? record.rich_text : [];
    const body = richText
      .map((segment) => {
        const item = segment && typeof segment === "object" ? segment as Record<string, unknown> : {};
        const text = item.text && typeof item.text === "object" ? (item.text as Record<string, unknown>).content : null;
        return typeof text === "string" ? text : (typeof item.plain_text === "string" ? item.plain_text : "");
      })
      .join("")
      .trim();
    if (!id || !body) continue;
    const createdBy = record.created_by && typeof record.created_by === "object"
      ? record.created_by as Record<string, unknown> : {};
    const displayName = record.display_name && typeof record.display_name === "object"
      ? record.display_name as Record<string, unknown> : {};
    const parent = record.parent && typeof record.parent === "object"
      ? record.parent as Record<string, unknown> : {};
    const blockId = typeof parent.block_id === "string" ? parent.block_id : null;
    const quotedText = blockId ? anchorsByBlock.get(blockId) ?? null : null;
    const createdAtMs = Date.parse(String(record.created_time ?? ""));
    parsed.push({
      id,
      discussionId: typeof record.discussion_id === "string" ? record.discussion_id : null,
      createdAt: Number.isFinite(createdAtMs) ? createdAtMs : 0,
      comment: {
        id,
        parentId: null,
        authorName: (typeof displayName.resolved_name === "string" && displayName.resolved_name.trim())
          || (typeof createdBy.name === "string" && createdBy.name.trim())
          || null,
        body,
        createdAt: typeof record.created_time === "string" ? record.created_time : null,
        updatedAt: typeof record.last_edited_time === "string" ? record.last_edited_time : null,
        resolved: null,
        anchor: blockId ? { blockId, quotedText } : null,
        sourceUrl: null,
        locationStatus: quotedText ? "located" : "unlocated",
      },
    });
  }
  parsed.sort((left, right) => left.createdAt - right.createdAt);
  const threadRoot = new Map<string, string>();
  for (const item of parsed) {
    if (!item.discussionId || threadRoot.has(item.discussionId)) continue;
    threadRoot.set(item.discussionId, item.id);
  }
  for (const item of parsed) {
    if (!item.discussionId) continue;
    const rootId = threadRoot.get(item.discussionId);
    if (rootId && rootId !== item.id) item.comment.parentId = rootId;
  }
  return parsed.map((item) => item.comment);
}

function warningsOf(value: unknown): ExternalDocumentWarning[] {
  return Array.isArray(value) ? (value as ExternalDocumentWarning[]) : [];
}

/**
 * 飞书 / Notion 文档导入编排。导入只经 OpenConnector 读 action；快照不可变，
 * Room 落地全部走 DocumentService（DocumentCommitService 乐观锁），不做任何
 * 远端同步状态机。
 */
export class DocumentImportService {
  private readonly actionRunner: ImportActionRunner;

  private readonly assetBridgeUrl: string | null;

  private readonly notionCli: NtnCliConfig | null;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly documents: DocumentService,
    private readonly connectorConfig: OpenConnectorCliConfig | null,
    private readonly dataDir: string,
    options?: {
      actionRunner?: ImportActionRunner;
      assetBridgeUrl?: string | null;
      /** Notion 行内（块级）评论兜底：OpenConnector 动作只覆盖页面级评论，
       * 行内评论须按 block_id 查询（官方 CLI；macOS）。缺省时跳过并告警。 */
      notionCli?: NtnCliConfig | null;
    },
  ) {
    this.actionRunner = options?.actionRunner ?? runImportConnectorAction;
    this.assetBridgeUrl = options?.assetBridgeUrl?.replace(/\/$/, "") ?? null;
    this.notionCli = options?.notionCli ?? null;
  }

  async search(
    provider: ExternalDocumentProvider,
    query: string,
    connectionName?: string,
  ): Promise<ExternalDocumentSearchResponse> {
    const adapter = this.adapterOf(provider, connectionName);
    return adapter.searchDocuments(query.trim())
      .then((result) => ({ provider, items: result.items, warnings: result.warnings }))
      .catch((error) => {
        throw this.mapConnectorError(error);
      });
  }

  /**
   * 按连接全量列举可导入文档（连接器页批量导入入口）。列举本身在 provider
   * 适配层完成；这里回填 imported 标记——该来源已有落 Room 的导入记录时置
   * true（重导入走现有候选版本语义，UI 仅提示不禁选）。成功结果写入列举
   * 缓存，供面板下次打开直接回显。
   */
  async listAllDocuments(
    provider: ExternalDocumentProvider,
    connectionName?: string,
  ): Promise<ExternalDocumentListResponse> {
    const adapter = this.adapterOf(provider, connectionName);
    const listed = await adapter.listAllDocuments().catch((error) => {
      throw this.mapConnectorError(error);
    });
    const items = this.markImported(provider, listed.items);
    const fetchedAt = new Date();
    this.db
      .insert(documentImportListCache)
      .values({
        provider,
        connectionName: connectionName ?? "",
        itemsJson: items,
        truncated: listed.truncated,
        warningsJson: listed.warnings,
        itemCount: items.length,
        fetchedAt,
      })
      .onConflictDoUpdate({
        target: [documentImportListCache.provider, documentImportListCache.connectionName],
        set: {
          itemsJson: items,
          truncated: listed.truncated,
          warningsJson: listed.warnings,
          itemCount: items.length,
          fetchedAt,
        },
      })
      .run();
    return { provider, items, truncated: listed.truncated, warnings: listed.warnings, fetchedAt: null };
  }

  /**
   * 目标 Room 已导入检查（批量导入前 UI 提示用）：返回这批远端文档中
   * 已在该 Room 落过 primary 文档的 remoteDocumentId 集合。
   */
  existingInRoom(
    provider: ExternalDocumentProvider,
    roomId: string,
    remoteDocumentIds: string[],
  ): string[] {
    if (remoteDocumentIds.length === 0) return [];
    const sources = this.db.select({
      id: documentImportSources.id,
      remoteDocumentId: documentImportSources.remoteDocumentId,
    }).from(documentImportSources)
      .where(and(
        eq(documentImportSources.ownerId, "local-user"),
        eq(documentImportSources.provider, provider),
        inArray(documentImportSources.remoteDocumentId, remoteDocumentIds),
      )).all();
    if (sources.length === 0) return [];
    const byRemote = new Map(sources.map((source) => [source.id, source.remoteDocumentId]));
    const landedSourceIds = this.db.select({ sourceId: documentImportRuns.sourceId })
      .from(documentRoomImports)
      .innerJoin(documentImportRuns, eq(documentRoomImports.importRunId, documentImportRuns.id))
      .where(and(
        eq(documentRoomImports.roomId, roomId),
        eq(documentRoomImports.relation, "primary"),
        inArray(documentImportRuns.sourceId, sources.map((source) => source.id)),
      )).all()
      .map((row) => row.sourceId)
      .filter((id): id is string => Boolean(id));
    return [...new Set(landedSourceIds.flatMap((id) => byRemote.get(id) ?? []))];
  }

  /**
   * 读取上次列举缓存（面板打开时的即时回显；imported 标记按当前库重算，
   * 导入后无需重拉）。无缓存返回 null，由调用方引导手动加载。
   */
  getCachedList(
    provider: ExternalDocumentProvider,
    connectionName?: string,
  ): ExternalDocumentListResponse | null {
    const row = this.db
      .select()
      .from(documentImportListCache)
      .where(and(
        eq(documentImportListCache.provider, provider),
        eq(documentImportListCache.connectionName, connectionName ?? ""),
      ))
      .get();
    if (!row) return null;
    const items = this.markImported(provider, row.itemsJson);
    return {
      provider,
      items,
      truncated: row.truncated,
      warnings: row.warningsJson,
      fetchedAt: row.fetchedAt.toISOString(),
    };
  }

  /** imported 标记回填：该来源已有落 Room 的导入记录时置 true。 */
  private markImported(
    provider: ExternalDocumentProvider,
    items: ExternalDocumentListItem[],
  ): ExternalDocumentListItem[] {
    const remoteIds = [...new Set(items.map((item) => item.remoteDocumentId))];
    if (remoteIds.length === 0) return items;
    const sources = this.db.select({
      id: documentImportSources.id,
      remoteDocumentId: documentImportSources.remoteDocumentId,
    }).from(documentImportSources)
      .where(and(
        eq(documentImportSources.ownerId, "local-user"),
        eq(documentImportSources.provider, provider),
        inArray(documentImportSources.remoteDocumentId, remoteIds),
      )).all();
    const sourceIds = sources.map((source) => source.id);
    const landedSourceIds = new Set(sourceIds.length > 0
      ? this.db.select({ sourceId: documentImportRuns.sourceId })
        .from(documentRoomImports)
        .innerJoin(documentImportRuns, eq(documentRoomImports.importRunId, documentImportRuns.id))
        .where(inArray(documentImportRuns.sourceId, sourceIds))
        .all()
        .map((row) => row.sourceId)
      : []);
    const landedRemoteIds = new Set(
      sources.filter((source) => landedSourceIds.has(source.id)).map((source) => source.remoteDocumentId),
    );
    for (const item of items) {
      if (landedRemoteIds.has(item.remoteDocumentId)) item.imported = true;
    }
    return items;
  }

  /**
   * 批量导入 auto 模式的全文读取器：从已完成的 preview run 拿回完整 markdown
   * （preview DTO 只有 4000 字符摘录）。供孵化投喂使用，不进 REST 面。
   */
  async getRunMarkdown(runId: string): Promise<{
    provider: ExternalDocumentProvider;
    remoteDocumentId: string;
    title: string;
    bodyMarkdown: string;
    sourceUrl: string | null;
  }> {
    const run = this.db.select().from(documentImportRuns)
      .where(eq(documentImportRuns.id, runId)).get();
    if (!run) {
      throw new ImportServiceError("IMPORT_RUN_NOT_FOUND", `导入记录不存在：${runId}`, 404);
    }
    if (!run.snapshotId) {
      throw new ImportServiceError("IMPORT_RUN_NOT_SNAPSHOTTED", `导入记录尚未完成读取：${runId}`, 409);
    }
    const snapshot = this.db.select().from(documentImportSnapshots)
      .where(eq(documentImportSnapshots.id, run.snapshotId)).get();
    if (!snapshot) {
      throw new ImportServiceError("IMPORT_SNAPSHOT_NOT_FOUND", `导入快照不存在：${run.snapshotId}`, 404);
    }
    const artifact = await this.loadArtifact(snapshot.artifactRef);
    return {
      provider: artifact.provider,
      remoteDocumentId: artifact.remoteDocumentId,
      title: artifact.title,
      bodyMarkdown: artifact.bodyMarkdown,
      sourceUrl: artifact.sourceUrl,
    };
  }

  async preview(
    provider: ExternalDocumentProvider,
    remoteDocumentId: string,
    connectionName?: string,
  ): Promise<ExternalDocumentPreview> {
    const adapter = this.adapterOf(provider, connectionName);
    const config = this.requireConfig();
    const runId = randomUUID();
    const now = new Date();
    this.db.insert(documentImportRuns).values({
      id: runId,
      requestId: randomUUID(),
      provider,
      remoteDocumentId,
      status: "reading",
      actionRefsJson: adapter.actionRefs,
    }).run();

    let artifact: CanonicalDocumentArtifact;
    try {
      const read = await adapter.readDocument(remoteDocumentId);
      let comments = artifactCommentsEmpty();
      let commentsStatus: CanonicalDocumentArtifact["commentsStatus"] = "unavailable";
      const warnings: ExternalDocumentWarning[] = [...read.warnings];
      try {
        const commentResult = await adapter.readComments(remoteDocumentId);
        comments = commentResult.comments;
        commentsStatus = commentResult.status;
        warnings.push(...commentResult.warnings);
      } catch (error) {
        // 评论读取失败不阻断正文导入，但必须显式标记，不能伪装成"没有评论"。
        commentsStatus = "failed";
        warnings.push({
          code: "comments_read_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      // Notion 行内（块级）评论兜底：list_page_comments 只覆盖页面级评论，
      // 行内评论须按 block_id 查询（blockId 在讨论标记 URL 第二段，真机核实）。
      // 用官方 ntn CLI 精确查询被评论的块；缺 ntn/未登录时告警跳过不阻断。
      if (provider === "notion" && this.notionCli) {
        const spans = discussionSpanBlockIds(read.bodyMarkdown);
        if (spans.length > 0) {
          try {
            const anchorsByBlock = new Map(spans.map((span) => [span.blockId, span.text]));
            const existingIds = new Set(comments.map((comment) => comment.id));
            for (const span of spans) {
              const { raw } = await runNtnCli(this.notionCli, [
                "api", "v1/comments", `block_id==${span.blockId}`, "page_size==100",
              ]);
              const results = raw && Array.isArray((raw as Record<string, unknown>).results)
                ? ((raw as Record<string, unknown>).results as Array<Record<string, unknown>>)
                : [];
              for (const comment of notionInlineCommentsOf(results, anchorsByBlock)) {
                if (!existingIds.has(comment.id)) {
                  existingIds.add(comment.id);
                  comments.push(comment);
                }
              }
            }
          } catch (error) {
            warnings.push({
              code: "notion_inline_comments_skipped",
              message: `行内评论读取跳过（需要 ntn 已登录）：${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      }
      // Notion 行内评论标记：<span discussion-urls="discussion://…">正文</span>。
      // 剥外壳保留正文（否则标记会以字面文本进编辑器），并按讨论 id 把引用
      // 文本回填为评论锚点——评论卡可停靠在正文对应位置而非"未定位区"。
      const anchored = anchorDiscussionSpans(read.bodyMarkdown, comments);
      artifact = {
        provider,
        remoteDocumentId,
        sourceUrl: read.sourceUrl,
        title: read.title.slice(0, 120),
        bodyMarkdown: anchored.markdown,
        assets: read.assets,
        comments: anchored.comments,
        commentsStatus,
        sourceRevision: read.sourceRevision,
        sourceUpdatedAt: read.sourceUpdatedAt,
        warnings,
      };
    } catch (error) {
      const mapped = this.mapConnectorError(error);
      this.finishRun(runId, "failed", mapped.code, mapped.message);
      throw mapped;
    }

    // 分页边界可能出现重复远端 id：按 id 去重（快照、预览与入库共用同一列表）。
    artifact = {
      ...artifact,
      comments: [...new Map(artifact.comments.map((comment) => [comment.id, comment])).values()],
    };
    // 远端图片物化（B-9）：经桌面资产桥 PUT 落 DocumentAssetStore，改写为本机
    // nxcore-document-asset:// URL（编辑器原生可渲染）；失败保留远端链接并告警。
    artifact = await this.materializeRemoteAssets(artifact, runId, provider, connectionName);

    const artifactRef = await storeArtifact(this.dataDir, artifact);
    const sourceId = await this.upsertSource(artifact);
    const snapshotId = randomUUID();
    const contentHash = artifactHashOf(Buffer.from(artifact.bodyMarkdown, "utf8"));
    this.db.insert(documentImportSnapshots).values({
      id: snapshotId,
      sourceId,
      importRunId: runId,
      artifactRef,
      contentHash,
      sourceRevision: artifact.sourceRevision,
      commentsStatus: artifact.commentsStatus,
      commentsHash: artifact.commentsStatus === "complete"
        ? artifactHashOf(Buffer.from(JSON.stringify(artifact.comments), "utf8"))
        : null,
      warningsJson: artifact.warnings,
    }).run();
    // 分页边界可能出现重复远端 id；按 remote id 去重（表上有唯一索引兜底）。
    const seenCommentIds = new Set<string>();
    for (const comment of artifact.comments) {
      if (seenCommentIds.has(comment.id)) continue;
      seenCommentIds.add(comment.id);
      this.db.insert(documentImportComments).values({
        id: randomUUID(),
        snapshotId,
        remoteCommentId: comment.id,
        parentRemoteCommentId: comment.parentId,
        authorJson: comment.authorName === null ? null : { name: comment.authorName },
        body: comment.body,
        quotedText: comment.anchor?.quotedText ?? null,
        anchorJson: comment.anchor,
        status: comment.resolved === null ? "unknown" : comment.resolved ? "resolved" : "open",
        sourceUrl: comment.sourceUrl,
        locationStatus: comment.locationStatus,
        commentCreatedAt: isoToDateOrNull(comment.createdAt),
        commentUpdatedAt: isoToDateOrNull(comment.updatedAt),
      }).run();
    }
    this.db.update(documentImportRuns).set({
      status: "preview",
      sourceId,
      snapshotId,
      warningsJson: artifact.warnings,
      updatedAt: new Date(),
    }).where(eq(documentImportRuns.id, runId)).run();

    return {
      runId,
      provider,
      remoteDocumentId,
      title: artifact.title,
      bodyExcerpt: artifact.bodyMarkdown.slice(0, 4000),
      sourceUrl: artifact.sourceUrl,
      sourceRevision: artifact.sourceRevision,
      sourceUpdatedAt: artifact.sourceUpdatedAt,
      comments: artifact.comments.map((comment) => ({
        id: comment.id,
        parentId: comment.parentId,
        authorName: comment.authorName,
        body: comment.body,
        quotedText: comment.anchor?.quotedText ?? null,
        resolved: comment.resolved,
        sourceUrl: comment.sourceUrl,
        locationStatus: comment.locationStatus,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      })),
      commentsStatus: artifact.commentsStatus,
      warnings: artifact.warnings,
    };
  }

  async commitToRoom(input: CommitImportInput): Promise<CommitImportResult> {
    const run = this.db.select().from(documentImportRuns).where(eq(documentImportRuns.id, input.runId)).get();
    if (!run) throw new ImportServiceError("NOT_FOUND", "导入任务不存在", 404);
    if (run.status !== "preview") {
      throw new ImportServiceError("IMPORT_RUN_NOT_PREVIEWABLE", `导入任务状态为 ${run.status}，不能提交`, 409);
    }
    const snapshot = run.snapshotId
      ? this.db.select().from(documentImportSnapshots).where(eq(documentImportSnapshots.id, run.snapshotId)).get()
      : null;
    if (!snapshot) throw new ImportServiceError("SNAPSHOT_MISSING", "导入快照缺失", 409);
    const artifact = await this.loadArtifact(snapshot.artifactRef);
    const contentJson = agentDocumentMarkdown.parse(artifact.bodyMarkdown) as RoomDocument["contentJson"];

    // 来源去重（方案 §3.1）：未显式指定目标文档时，若该 Room 已导入过同一来源
    // （relation=primary 且文档仍存在），自动转为该文档的候选版本，不重复落新文档。
    // forceNewDocument=true 跳过（批量导入"创建新的"，用户已在 UI 明确选择）。
    let targetDocumentId = input.targetDocumentId ?? null;
    if (!targetDocumentId && run.sourceId && !input.forceNewDocument) {
      const existing = this.db.select({ documentId: documentRoomImports.documentId })
        .from(documentRoomImports)
        .innerJoin(documentImportRuns, eq(documentRoomImports.importRunId, documentImportRuns.id))
        .where(and(
          eq(documentRoomImports.roomId, input.roomId),
          eq(documentImportRuns.sourceId, run.sourceId),
          eq(documentRoomImports.relation, "primary"),
        ))
        .orderBy(desc(documentRoomImports.createdAt))
        .all()
        .map((row) => row.documentId)
        .find((documentId) => Boolean(this.documents.get(documentId)));
      targetDocumentId = existing ?? null;
    }

    const isCandidate = targetDocumentId !== null;

    // 无变化守卫（防空候选堆积）：候选路径下，新快照内容与该文档最近一次
    // 已应用快照（primary 或已应用 candidate，按 content_hash）相同时，
    // 不物化候选、不落 roomImport——调用方据此提示"远端无更新"。
    if (isCandidate && targetDocumentId) {
      const lastApplied = this.db.select({ snapshotId: documentRoomImports.snapshotId })
        .from(documentRoomImports)
        .where(and(
          eq(documentRoomImports.documentId, targetDocumentId),
          isNotNull(documentRoomImports.importedVersion),
        ))
        .orderBy(desc(documentRoomImports.createdAt))
        .get();
      if (lastApplied) {
        const lastSnapshot = this.db.select({ contentHash: documentImportSnapshots.contentHash })
          .from(documentImportSnapshots)
          .where(eq(documentImportSnapshots.id, lastApplied.snapshotId))
          .get();
        if (lastSnapshot && lastSnapshot.contentHash === snapshot.contentHash) {
          const current = this.documents.get(targetDocumentId);
          if (current) {
            this.finishRun(run.id, "succeeded");
            return {
              run: this.getRun(run.id),
              roomImportId: null,
              relation: "candidate",
              noChange: true,
              documentId: targetDocumentId,
              document: current,
            };
          }
        }
      }
    }

    const roomImportId = randomUUID();
    let document: RoomDocument;
    let candidateDocumentId: string | null = null;
    let importedVersion: number | null = null;

    this.db.update(documentImportRuns).set({
      status: "committing",
      targetRoomId: input.roomId,
      targetDocumentId: targetDocumentId,
      updatedAt: new Date(),
    }).where(eq(documentImportRuns.id, run.id)).run();

    if (isCandidate) {
      // 再次导入：物化独立的候选文档，不覆盖当前 Room 文档（方案 §5.3）。
      const candidateTitle = `${artifact.title}（外部更新候选）`.slice(0, 120);
      document = await this.documents.import({
        id: `imp-cand-${randomUUID()}`,
        roomId: input.roomId,
        title: candidateTitle,
        contentJson,
      });
      candidateDocumentId = document.id;
    } else {
      document = await this.documents.import({
        id: `imp-${randomUUID()}`,
        roomId: input.roomId,
        title: artifact.title,
        contentJson,
      });
      importedVersion = document.version;
    }

    this.db.insert(documentRoomImports).values({
      id: roomImportId,
      roomId: input.roomId,
      documentId: targetDocumentId ?? document.id,
      importRunId: run.id,
      snapshotId: snapshot.id,
      importedVersion,
      relation: isCandidate ? "candidate" : "primary",
      candidateDocumentId,
    }).run();
    this.finishRun(run.id, "succeeded");

    return {
      run: this.getRun(run.id),
      roomImportId,
      relation: isCandidate ? "candidate" : "primary",
      documentId: isCandidate ? candidateDocumentId! : document.id,
      document,
    };
  }

  /**
   * "检查外部更新"：对已挂接外部来源的 Room 文档重新读取远端并生成候选版本。
   * 与"应用此版本"（applyCandidate）是两个独立动作。
   */
  async checkExternalUpdate(roomId: string, documentId: string): Promise<CommitImportResult> {
    const rows = this.db.select()
      .from(documentRoomImports)
      .where(and(eq(documentRoomImports.roomId, roomId), eq(documentRoomImports.documentId, documentId)))
      .orderBy(desc(documentRoomImports.createdAt))
      .all();
    if (rows.length === 0) {
      throw new ImportServiceError("NO_IMPORT_SOURCE", "该文档没有外部导入来源", 404);
    }
    const latest = rows[0]!;
    const run = this.db.select().from(documentImportRuns).where(eq(documentImportRuns.id, latest.importRunId)).get();
    if (!run?.sourceId) {
      throw new ImportServiceError("NO_IMPORT_SOURCE", "该文档的导入记录缺少来源信息", 409);
    }
    const source = this.db.select().from(documentImportSources).where(eq(documentImportSources.id, run.sourceId)).get();
    if (!source) {
      throw new ImportServiceError("NO_IMPORT_SOURCE", "导入来源记录缺失", 409);
    }
    const preview = await this.preview(source.provider, source.remoteDocumentId);
    return this.commitToRoom({
      runId: preview.runId,
      roomId,
      targetDocumentId: documentId,
    });
  }

  /** "应用此版本"：把候选快照提交为当前文档的正式新版本。 */
  async applyCandidate(roomImportId: string): Promise<{ document: RoomDocument; version: number }> {
    const row = this.db.select().from(documentRoomImports).where(eq(documentRoomImports.id, roomImportId)).get();
    if (!row) throw new ImportServiceError("NOT_FOUND", "导入关联记录不存在", 404);
    if (row.relation !== "candidate") {
      throw new ImportServiceError("NOT_A_CANDIDATE", "只有候选导入才能应用此版本", 409);
    }
    if (row.importedVersion !== null) {
      throw new ImportServiceError("CANDIDATE_ALREADY_APPLIED", "该候选版本已应用", 409);
    }
    const snapshot = this.db.select().from(documentImportSnapshots).where(eq(documentImportSnapshots.id, row.snapshotId)).get();
    if (!snapshot) throw new ImportServiceError("SNAPSHOT_MISSING", "导入快照缺失", 409);
    const artifact = await this.loadArtifact(snapshot.artifactRef);
    const target = this.documents.get(row.documentId);
    if (!target) throw new ImportServiceError("NOT_FOUND", "目标文档不存在", 404);
    if (target.roomId !== row.roomId) {
      throw new ImportServiceError("ROOM_MISMATCH", "目标文档属于其他 Room", 409);
    }
    if (target.deletedAt) {
      throw new ImportServiceError("DOCUMENT_TRASHED", "目标文档已在回收站，先恢复再应用", 409);
    }
    if (target.activeTransactionId) {
      throw new ImportServiceError("DOCUMENT_BUSY", "Agent 正在写入该文档", 409);
    }
    const contentJson = agentDocumentMarkdown.parse(artifact.bodyMarkdown) as RoomDocument["contentJson"];
    const saved = await this.documents.save(row.documentId, {
      baseVersion: target.version,
      title: artifact.title,
      contentJson,
    });
    // 应用外部更新后失效 AI 速览：标题已随 save 更新，旧摘要不得冒充新内容。
    // 按产品懒生成策略，速览在下次读取/打开时对新正文自动重生成。
    this.db.update(documents)
      .set({ overviewText: null, overviewVersion: null, overviewGeneratedAt: null })
      .where(eq(documents.id, row.documentId))
      .run();
    this.db.update(documentRoomImports).set({ importedVersion: saved.version }).where(eq(documentRoomImports.id, roomImportId)).run();
    return { document: saved, version: saved.version };
  }

  async importHistory(roomId: string, documentId: string): Promise<{
    entries: DocumentImportHistoryEntry[];
    commentDiff: DocumentImportCommentDiffSummary | null;
    comments: ExternalDocumentCommentView[];
  }> {
    const rows = this.db.select({
      roomImport: documentRoomImports,
      run: documentImportRuns,
      snapshot: documentImportSnapshots,
      source: documentImportSources,
    })
      .from(documentRoomImports)
      .innerJoin(documentImportRuns, eq(documentRoomImports.importRunId, documentImportRuns.id))
      .innerJoin(documentImportSnapshots, eq(documentRoomImports.snapshotId, documentImportSnapshots.id))
      .innerJoin(documentImportSources, eq(documentImportRuns.sourceId, documentImportSources.id))
      .where(and(eq(documentRoomImports.roomId, roomId), eq(documentRoomImports.documentId, documentId)))
      .orderBy(desc(documentRoomImports.createdAt))
      .all();
    const entries: DocumentImportHistoryEntry[] = rows.map(({ roomImport, snapshot, source }) => ({
      importRunId: roomImport.importRunId,
      roomImportId: roomImport.id,
      snapshotId: snapshot.id,
      relation: roomImport.relation,
      importedVersion: roomImport.importedVersion,
      candidateDocumentId: roomImport.candidateDocumentId,
      provider: source.provider,
      remoteDocumentId: source.remoteDocumentId,
      displayTitle: source.displayTitle ?? "外部文档",
      sourceUrl: source.sourceUrl,
      sourceRevision: snapshot.sourceRevision,
      capturedAt: snapshot.capturedAt.toISOString(),
      commentsStatus: snapshot.commentsStatus,
      warnings: warningsOf(snapshot.warningsJson),
    }));
    const commentDiff = rows.length >= 2
      ? this.commentDiffSummary(rows.map((row) => row.snapshot.id))
      : null;
    // 最新快照的评论（只读面板数据，B-1）；无记录时返回空。
    const comments = rows[0]
      ? this.db.select().from(documentImportComments)
        .where(eq(documentImportComments.snapshotId, rows[0].snapshot.id))
        .orderBy(documentImportComments.parentRemoteCommentId, documentImportComments.remoteCommentId)
        .all()
        .slice(0, 200)
        .map((row) => ({
          id: row.remoteCommentId,
          parentId: row.parentRemoteCommentId,
          authorName: row.authorJson?.name ?? null,
          body: row.body,
          quotedText: row.quotedText,
          resolved: row.status === "resolved" ? true : row.status === "open" ? false : null,
          sourceUrl: row.sourceUrl,
          locationStatus: row.locationStatus,
          createdAt: row.commentCreatedAt?.toISOString() ?? null,
          updatedAt: row.commentUpdatedAt?.toISOString() ?? null,
        }))
      : [];
    return { entries, commentDiff, comments };
  }

  /** 候选 vs 当前文档的行级 diff（B-2）：服务端算 hunks，前端只渲染。 */
  /**
   * 候选 vs 当前版本的结构化 diff（复用版本 diff 核心算法与渲染契约）：
   * 版本时间轴的"导入版本"卡片点击后进入既有 diff UI 的数据源。
   * before=当前版本内容，after=候选内容；toVersion 回填当前版本号（编辑器以
   * toVersion 判定 diff 视图是否仍有效）。快照为候选伪版本（version=当前版本号）。
   */
  async candidateStructuredDiff(roomImportId: string): Promise<{
    candidate: { roomImportId: string; provider: ExternalDocumentProvider; title: string; capturedAt: string };
    snapshot: {
      documentId: string;
      version: number;
      title: string;
      contentJson: RoomDocument["contentJson"];
      contentSchemaVersion: number;
      sourceTransactionId: string | null;
      createdAt: string;
      yjsBackfilled: boolean;
    };
    diff: import("@nxcore/agent-contract").DocumentDiffResult;
  }> {
    const row = this.db.select().from(documentRoomImports).where(eq(documentRoomImports.id, roomImportId)).get();
    if (!row) throw new ImportServiceError("NOT_FOUND", "导入关联记录不存在", 404);
    if (row.relation !== "candidate") throw new ImportServiceError("NOT_A_CANDIDATE", "只有候选导入才能对比差异", 409);
    if (row.importedVersion !== null) throw new ImportServiceError("CANDIDATE_ALREADY_APPLIED", "该候选版本已应用", 409);
    if (!row.candidateDocumentId) throw new ImportServiceError("SNAPSHOT_MISSING", "候选文档缺失", 409);
    const run = this.db.select().from(documentImportRuns).where(eq(documentImportRuns.id, row.importRunId)).get();
    const source = run?.sourceId
      ? this.db.select().from(documentImportSources).where(eq(documentImportSources.id, run.sourceId)).get()
      : null;
    if (!source) throw new ImportServiceError("IMPORT_RUN_NOT_FOUND", "导入来源记录缺失", 409);
    const snapshotRow = this.db.select().from(documentImportSnapshots).where(eq(documentImportSnapshots.id, row.snapshotId)).get();
    if (!snapshotRow) throw new ImportServiceError("SNAPSHOT_MISSING", "导入快照缺失", 409);
    const target = this.documents.get(row.documentId);
    if (!target) throw new ImportServiceError("NOT_FOUND", "目标文档不存在", 404);
    const candidateDocument = this.documents.get(row.candidateDocumentId);
    const candidateContent = candidateDocument?.contentJson
      ?? agentDocumentMarkdown.parse((await this.loadArtifact(snapshotRow.artifactRef)).bodyMarkdown) as RoomDocument["contentJson"];
    const cleanTitle = (candidateDocument?.title ?? snapshotRow.contentHash.slice(0, 8)).replace(/（外部更新候选）\s*$/, "");
    return {
      candidate: {
        roomImportId,
        provider: source.provider,
        title: cleanTitle,
        capturedAt: snapshotRow.capturedAt.toISOString(),
      },
      snapshot: {
        documentId: target.id,
        version: target.version,
        title: cleanTitle,
        contentJson: candidateContent,
        contentSchemaVersion: candidateDocument?.contentSchemaVersion ?? 1,
        sourceTransactionId: null,
        createdAt: snapshotRow.capturedAt.toISOString(),
        yjsBackfilled: true,
      },
      diff: refineContainerDiff(this.documents.diffContents(
        target.id,
        target.contentJson,
        candidateContent,
        { fromVersion: target.version, toVersion: target.version },
      )),
    };
  }

  async candidateDiff(roomImportId: string): Promise<{
    candidateTitle: string;
    currentTitle: string;
    appliedVersion: number | null;
    hunks: Array<{ type: "ctx" | "add" | "del"; text: string }>;
    commentsComparable: boolean;
  }> {
    const { diffLines } = await import("diff");
    const row = this.db.select().from(documentRoomImports).where(eq(documentRoomImports.id, roomImportId)).get();
    if (!row) throw new ImportServiceError("NOT_FOUND", "导入关联记录不存在", 404);
    const snapshot = this.db.select().from(documentImportSnapshots).where(eq(documentImportSnapshots.id, row.snapshotId)).get();
    if (!snapshot) throw new ImportServiceError("SNAPSHOT_MISSING", "导入快照缺失", 409);
    const artifact = await this.loadArtifact(snapshot.artifactRef);
    const target = this.documents.get(row.documentId);
    if (!target) throw new ImportServiceError("NOT_FOUND", "目标文档不存在", 404);
    const currentSnapshot = this.documents.getVersionSnapshot(row.documentId, target.version);
    if (!currentSnapshot) throw new ImportServiceError("NOT_FOUND", "当前版本快照缺失", 409);
    const { agentDocumentMarkdown } = await import("../agent-markdown.js");
    const currentMarkdown = agentDocumentMarkdown.serialize(currentSnapshot.contentJson);
    const parts = diffLines(currentMarkdown, artifact.bodyMarkdown);
    // 折叠未变更区域：仅保留变更行 ±3 行上下文。
    const KEEP_CTX = 3;
    const keep = new Array<boolean>(parts.length).fill(false);
    parts.forEach((part, index) => {
      if (part.added || part.removed) {
        for (let near = index - KEEP_CTX; near <= index + KEEP_CTX; near += 1) {
          if (near >= 0 && near < parts.length) keep[near] = true;
        }
      }
    });
    const hunks: Array<{ type: "ctx" | "add" | "del"; text: string }> = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part || !keep[index]) continue;
      const type = part.added ? "add" : part.removed ? "del" : "ctx";
      const last = hunks.at(-1);
      const text = part.value.replace(/\n$/, "");
      if (last && last.type === type) last.text += `\n${text}`;
      else hunks.push({ type, text });
    }
    return {
      candidateTitle: `${artifact.title}（外部更新候选）`,
      currentTitle: target.title,
      appliedVersion: row.importedVersion,
      hunks,
      commentsComparable: snapshot.commentsStatus === "complete",
    };
  }

  getRun(runId: string): DocumentImportRunView {
    const run = this.db.select().from(documentImportRuns).where(eq(documentImportRuns.id, runId)).get();
    if (!run) throw new ImportServiceError("NOT_FOUND", "导入任务不存在", 404);
    const snapshot = run.snapshotId
      ? this.db.select().from(documentImportSnapshots).where(eq(documentImportSnapshots.id, run.snapshotId)).get()
      : undefined;
    return {
      id: run.id,
      requestId: run.requestId,
      provider: run.provider,
      remoteDocumentId: run.remoteDocumentId,
      sourceId: run.sourceId,
      snapshotId: run.snapshotId,
      targetRoomId: run.targetRoomId,
      targetDocumentId: run.targetDocumentId,
      status: run.status,
      warnings: warningsOf(run.warningsJson),
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      commentsStatus: snapshot?.commentsStatus ?? null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    };
  }

  cancelRun(runId: string): DocumentImportRunView {
    const run = this.db.select().from(documentImportRuns).where(eq(documentImportRuns.id, runId)).get();
    if (!run) throw new ImportServiceError("NOT_FOUND", "导入任务不存在", 404);
    if (run.status === "searching" || run.status === "reading" || run.status === "preview") {
      this.finishRun(runId, "cancelled");
    }
    return this.getRun(runId);
  }

  private commentDiffSummary(snapshotIds: string[]): DocumentImportCommentDiffSummary {
    const [newerId, olderId] = snapshotIds;
    const loadComments = (snapshotId: string) => this.db.select()
      .from(documentImportComments)
      .where(eq(documentImportComments.snapshotId, snapshotId))
      .all();
    const newer = loadComments(newerId!);
    const older = loadComments(olderId!);
    const newerStatus = this.db.select().from(documentImportSnapshots).where(eq(documentImportSnapshots.id, newerId!)).get()?.commentsStatus;
    const olderStatus = this.db.select().from(documentImportSnapshots).where(eq(documentImportSnapshots.id, olderId!)).get()?.commentsStatus;
    // 只有两次快照评论都完整时才可比；缺失不能误判为全部删除（方案 §4.2）。
    if (newerStatus !== "complete" || olderStatus !== "complete") {
      return { comparable: false, added: 0, resolved: 0, modified: 0, removed: 0, reason: "comments_incomplete" };
    }
    const olderById = new Map(older.map((row) => [row.remoteCommentId, row]));
    const newerIds = new Set(newer.map((row) => row.remoteCommentId));
    let added = 0;
    let modified = 0;
    let resolved = 0;
    for (const row of newer) {
      const before = olderById.get(row.remoteCommentId);
      if (!before) added += 1;
      else {
        if (before.body !== row.body) modified += 1;
        if (before.status === "open" && row.status === "resolved") resolved += 1;
      }
    }
    const removed = older.filter((row) => !newerIds.has(row.remoteCommentId)).length;
    return { comparable: true, added, resolved, modified, removed, reason: null };
  }

  /**
   * 飞书图片真实地址解析：markdown 导出给的是 `feishu.cn/file/<token>` 文件页
   * 链接（HTML，非字节），直接 fetch 必失败。先经运行时 download_docs_media
   * 动作（带连接鉴权）把媒体落到运行时中转存储，返回的 downloadUrl 才是
   * 可直接下载的字节地址（真机核实：image/png 200）。
   */
  private async resolveFeishuImageBytesUrl(
    url: string,
    provider: ExternalDocumentProvider,
    connectionName?: string,
  ): Promise<string | null> {
    if (provider !== "feishu") return null;
    const token = /feishu\.cn\/file\/([A-Za-z0-9]+)/.exec(url)?.[1];
    if (!token) return null;
    const config = this.requireConfig();
    try {
      const result = objectValueish(await this.actionRunner(
        config,
        {
          service: "feishu",
          action: "download_docs_media",
          input: { token, type: "media", fileName: "image" },
          ...(connectionName ? { connectionName } : {}),
        },
      ));
      const downloadUrl = typeof result.downloadUrl === "string" && result.downloadUrl
        ? result.downloadUrl
        : typeof (objectValueish(result.data)).downloadUrl === "string"
          ? (objectValueish(result.data)).downloadUrl as string
          : null;
      return downloadUrl;
    } catch {
      return null;
    }
  }

  private async materializeRemoteAssets(
    artifact: CanonicalDocumentArtifact,
    runId: string,
    provider: ExternalDocumentProvider,
    connectionName?: string,
  ): Promise<CanonicalDocumentArtifact> {
    if (!this.assetBridgeUrl) return artifact;
    const bridge = this.assetBridgeUrl;
    const syntheticDocId = `import-${runId.slice(0, 12)}`;
    const warnings: ExternalDocumentWarning[] = [...artifact.warnings];
    let materialized = 0;
    let failed = 0;
    const failedReasons: string[] = [];
    const bodyMarkdown = await replaceAsync(artifact.bodyMarkdown, /!\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)[^)]*\)/g,
      async (full: string, alt: string, url: string) => {
        if (materialized + failed >= 10) return full;
        try {
          const bytesUrl = (await this.resolveFeishuImageBytesUrl(url, provider, connectionName)) ?? url;
          const response = await fetch(bytesUrl, { signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("图片超过 5MB");
          // 以魔数嗅探为准：远端/中转声明的 content-type 可能与真实字节不符
          // （实测飞书中转 PNG 字节配 image/jpeg 头，资产桥签名校验会拒收 400）。
          const headerMime = ((response.headers.get("content-type") ?? "").split(";")[0] ?? "").trim();
          const mime = sniffImageMime(bytes)
            ?? (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(headerMime) ? headerMime : null);
          if (!mime) throw new Error(`不支持的图片类型 ${headerMime || "unknown"}`);
          const put = await fetch(`${bridge}?doc=${encodeURIComponent(syntheticDocId)}`, {
            method: "PUT",
            headers: { "Content-Type": mime },
            body: bytes,
            signal: AbortSignal.timeout(15_000),
          });
          if (!put.ok) throw new Error(`资产桥 PUT ${String(put.status)}`);
          const stored = await put.json() as { src?: unknown };
          const src = typeof stored.src === "string" ? stored.src : null;
          if (!src) throw new Error("资产桥未返回 src");
          materialized += 1;
          return `![${alt}](${src})`;
        } catch (error) {
          failed += 1;
          failedReasons.push(`${url.slice(0, 60)}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160));
          return full;
        }
      });
    if (materialized > 0) {
      warnings.push({
        code: "remote_assets_materialized",
        message: `${String(materialized)} 张远端图片已下载为本机资产`,
      });
    }
    if (failed > 0) {
      warnings.push({
        code: "asset_materialize_failed",
        message: `${String(failed)} 张远端图片下载失败，保留原链接；原因：${failedReasons.join("；")}`,
      });
    }
    return { ...artifact, bodyMarkdown, warnings };
  }

  private async loadArtifact(ref: string): Promise<CanonicalDocumentArtifact> {
    const value = await readArtifact(this.dataDir, ref);
    if (!value || typeof value !== "object") {
      throw new ImportServiceError("ARTIFACT_INVALID", "导入快照内容无效", 500);
    }
    return value as CanonicalDocumentArtifact;
  }

  private async upsertSource(artifact: CanonicalDocumentArtifact): Promise<string> {
    const existing = this.db.select().from(documentImportSources)
      .where(and(
        eq(documentImportSources.ownerId, "local-user"),
        eq(documentImportSources.provider, artifact.provider),
        eq(documentImportSources.remoteDocumentId, artifact.remoteDocumentId),
      ))
      .get();
    if (existing) {
      this.db.update(documentImportSources).set({
        sourceUrl: artifact.sourceUrl,
        displayTitle: artifact.title,
        lastSeenRevision: artifact.sourceRevision,
        updatedAt: new Date(),
      }).where(eq(documentImportSources.id, existing.id)).run();
      return existing.id;
    }
    const id = randomUUID();
    this.db.insert(documentImportSources).values({
      id,
      ownerId: "local-user",
      provider: artifact.provider,
      remoteDocumentId: artifact.remoteDocumentId,
      sourceUrl: artifact.sourceUrl,
      displayTitle: artifact.title,
      lastSeenRevision: artifact.sourceRevision,
    }).run();
    return id;
  }

  private finishRun(runId: string, status: DocumentImportRunStatusLike, errorCode?: string, errorMessage?: string): void {
    this.db.update(documentImportRuns).set({
      status,
      errorCode: errorCode ?? null,
      errorMessage: errorMessage ?? null,
      updatedAt: new Date(),
      completedAt: ["succeeded", "failed", "cancelled"].includes(status) ? new Date() : null,
    }).where(eq(documentImportRuns.id, runId)).run();
  }

  private requireConfig(): OpenConnectorCliConfig {
    if (!this.connectorConfig) {
      throw new ImportServiceError(
        "OPEN_CONNECTOR_UNAVAILABLE",
        "OpenConnector 连接层未配置或不可用，导入入口暂不可用",
        503,
      );
    }
    return this.connectorConfig;
  }

  private adapterOf(provider: ExternalDocumentProvider, connectionName?: string): ExternalDocumentProviderAdapter {
    const config = this.requireConfig();
    // 连接器页按连接列举/批量导入：入口解析出的连接名显式注入每个 action 调用
    // （call 自带 connectionName 时以 call 为准），避免长任务中途连接解析漂移。
    const run: ImportActionFn = (call, signal) => {
      const resolvedConnection = call.connectionName ?? connectionName;
      return this.actionRunner(
        config,
        resolvedConnection ? { ...call, connectionName: resolvedConnection } : call,
        signal,
      );
    };
    return importAdapterOf(provider, run);
  }

  private mapConnectorError(error: unknown): ImportServiceError {
    if (error instanceof ImportServiceError) return error;
    if (error instanceof ImportConnectorError) {
      if (error.code === "authentication_required" || error.code === "no_connection") {
        return new ImportServiceError(
          "IMPORT_CONNECTION_REQUIRED",
          `导入连接不可用：${error.detail}。请在连接器管理中建立该服务的导入连接。`,
          422,
        );
      }
      if (error.code === "action_not_found") {
        return new ImportServiceError("IMPORT_ACTION_MISSING", `OpenConnector 动作不可用：${error.detail}`, 502);
      }
      if (error.code === "connector_unavailable") {
        return new ImportServiceError("OPEN_CONNECTOR_UNAVAILABLE", `OpenConnector 服务不可用：${error.detail}`, 503);
      }
      return new ImportServiceError("IMPORT_READ_FAILED", `外部文档读取失败：${error.detail}`, 502);
    }
    return new ImportServiceError(
      "IMPORT_READ_FAILED",
      error instanceof Error ? error.message : String(error),
      502,
    );
  }
}

type DocumentImportRunStatusLike = DocumentImportRunView["status"];

function artifactCommentsEmpty(): CanonicalDocumentArtifact["comments"] {
  return [];
}


/** 顺序执行的异步正则替换（物化远端图片用）。 */
async function replaceAsync(
  source: string,
  pattern: RegExp,
  replacer: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const tasks: Array<Promise<string>> = [];
  source.replace(pattern, (match: string, ...groups: string[]) => {
    tasks.push(replacer(match, ...groups.slice(0, -2)));
    return match;
  });
  const results = await Promise.all(tasks);
  let cursor = 0;
  return source.replace(pattern, () => results[cursor++] ?? "");
}
