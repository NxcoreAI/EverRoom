import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  agentMessages,
  agentSessions,
  documents,
  fileEntries,
  fileVersions,
  jobs,
  parsedContents,
  parsedDocuments,
  searchIndex,
} from "../../infrastructure/database/schema.js";
import { isSingleCharQuery, tokenizeJoined } from "./tokenizer.js";
import {
  enqueueSearchIndex,
  SEARCH_INDEX_HIGH_JOB_TYPE,
  SEARCH_INDEX_JOB_TYPE,
  SEARCH_WORKER_JOB_TYPES,
  type SearchIndexJobPayload,
  type SearchItemType,
} from "./jobs.js";

const FTS_BODY_LIMIT = 32 * 1024;
const PREVIEW_LIMIT = 4 * 1024;
const SNIPPET_WINDOW = 160;
const MAX_ATTEMPTS = 3;

const ITEM_TYPES: readonly SearchItemType[] = ["file", "message", "document", "export"];

/**
 * 检索过滤条件。Phase 2i 起 Room 维度已删除：`roomIds` 过滤会命中空集，
 * 因此直接从契约里删掉，不再向下传递。
 */
export interface SearchFilters {
  types?: string[] | undefined;
  timeBasis?: "occurred" | "ingested" | undefined;
  from?: number | undefined;
  to?: number | undefined;
}

export interface SearchHit {
  id: string;
  itemType: SearchItemType;
  refId: string;
  title: string;
  snippet: string;
  sourceKind: string | null;
  /**
   * 稳定而恒为空的字段：桌面搜索面板按 roomIds 渲染归属徽标并做命中跳转
   * （`hit.roomIds[0]`），Phase 2i 删掉 Room 维度后保留空数组避免渲染层崩溃。
   */
  roomIds: string[];
  occurredAt: string | null;
  ingestedAt: string;
  timeBasis: "occurred" | "ingested";
  versionLabel: string | null;
  fileVersionId: string | null;
  status: "meta_only" | "indexed" | "failed";
  sessionId: string | null;
  pageId: string | null;
}

export interface SearchPage {
  items: SearchHit[];
  total: number;
  scope: { indexedCount: number; pendingCount: number };
}

interface ItemMeta {
  title: string;
  body: string;
  sourceKind: string | null;
  occurredAt: Date | null;
  ingestedAt: Date;
  timeBasis: "occurred" | "ingested";
  fileVersionId: string | null;
  versionLabel: string | null;
  sessionId: string | null;
}

interface IndexRow {
  id: string;
  item_type: SearchItemType;
  ref_id: string;
  title: string;
  body_preview: string;
  source_kind: string | null;
  occurred_at: number | null;
  ingested_at: number;
  time_basis: "occurred" | "ingested";
  version_label: string | null;
  file_version_id: string | null;
  session_id: string | null;
  status: "meta_only" | "indexed" | "failed";
}

export class SearchService {
  private timer: NodeJS.Timeout | null = null;
  private initialDrainTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private stopped = false;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly sqlite: Database.Database,
  ) {}

  // ---------------------------------------------------------------- indexing

  /** 读源表重建一个条目；源行消失或已删除时移除索引行。 */
  reindexItem(itemType: SearchItemType, refId: string): "indexed" | "meta_only" | "removed" {
    if (!ITEM_TYPES.includes(itemType)) return "removed";
    const meta = this.loadMeta(itemType, refId);
    if (!meta) {
      this.removeItem(itemType, refId);
      return "removed";
    }
    const indexId = `${itemType}:${refId}`;
    const now = new Date();
    const hasBody = meta.body.trim().length > 0;
    const values = {
      id: indexId,
      itemType,
      refId,
      title: meta.title.slice(0, 500),
      bodyPreview: meta.body.slice(0, PREVIEW_LIMIT),
      sourceKind: meta.sourceKind,
      occurredAt: meta.occurredAt,
      ingestedAt: meta.ingestedAt,
      timeBasis: meta.timeBasis,
      fileVersionId: meta.fileVersionId,
      versionLabel: meta.versionLabel,
      sessionId: meta.sessionId ?? null,
      status: hasBody ? ("indexed" as const) : ("meta_only" as const),
      updatedAt: now,
    };
    this.db.transaction((tx) => {
      const existing = tx.select({ id: searchIndex.id }).from(searchIndex).where(eq(searchIndex.id, indexId)).get();
      if (existing) {
        tx.update(searchIndex).set(values).where(eq(searchIndex.id, indexId)).run();
      } else {
        tx.insert(searchIndex).values(values).run();
      }
    });
    this.refreshFts(indexId, values.title, meta.body);
    return hasBody ? "indexed" : "meta_only";
  }

  removeItem(itemType: SearchItemType, refId: string): void {
    const indexId = `${itemType}:${refId}`;
    const row = this.sqlite.prepare("SELECT rowid FROM search_index WHERE id=?").get(indexId) as { rowid: number } | undefined;
    this.sqlite.transaction(() => {
      if (row) this.sqlite.prepare("DELETE FROM search_index_fts WHERE rowid=?").run(row.rowid);
      this.sqlite.prepare("DELETE FROM search_index WHERE id=?").run(indexId);
    })();
  }

  private refreshFts(indexId: string, title: string, body: string): void {
    const row = this.sqlite.prepare("SELECT rowid FROM search_index WHERE id=?").get(indexId) as { rowid: number } | undefined;
    if (!row) return;
    this.sqlite.prepare("DELETE FROM search_index_fts WHERE rowid=?").run(row.rowid);
    const tokens = tokenizeJoined(`${title}\n${body.slice(0, FTS_BODY_LIMIT)}`);
    if (tokens) {
      this.sqlite.prepare("INSERT INTO search_index_fts(rowid, tokens) VALUES(?,?)").run(row.rowid, tokens);
    }
  }

  // ------------------------------------------------------------- item loaders

  private loadMeta(itemType: SearchItemType, refId: string): ItemMeta | null {
    switch (itemType) {
      case "file":
        return this.loadFile(refId);
      case "message":
        return this.loadMessage(refId);
      case "document":
        return this.loadDocument(refId);
      default:
        return null;
    }
  }

  private loadFile(refId: string): ItemMeta | null {
    const entry = this.db.select().from(fileEntries).where(eq(fileEntries.id, refId)).get();
    if (!entry || entry.deletedAt || entry.state === "deleted" || entry.state === "missing") return null;
    const version = entry.currentVersionId
      ? this.db.select().from(fileVersions).where(eq(fileVersions.id, entry.currentVersionId)).get()
      : undefined;
    const parsed = version?.parsedId
      ? this.db.select({ markdown: parsedContents.markdown }).from(parsedContents).where(eq(parsedContents.id, version.parsedId)).get()
      : version
        // 新解析器落 parsed_documents（parsed_id 对 pdoc 无效）：按版本反查正文，
        // 否则 Office 文件在统一搜索里始终是空正文。
        ? this.db.select({ markdown: parsedDocuments.markdown }).from(parsedDocuments).where(eq(parsedDocuments.fileVersionId, version.id)).get()
        : undefined;
    const occurredAt = version?.sourceModifiedAt ?? null;
    return {
      title: entry.displayName || entry.originalName,
      body: parsed?.markdown ?? "",
      sourceKind: entry.sourceKind,
      occurredAt,
      ingestedAt: entry.createdAt,
      timeBasis: occurredAt ? "occurred" : "ingested",
      fileVersionId: version?.id ?? null,
      versionLabel: version ? `v${version.versionNo}` : null,
      sessionId: null,
    };
  }

  private loadMessage(refId: string): ItemMeta | null {
    const message = this.db.select().from(agentMessages).where(eq(agentMessages.id, refId)).get();
    if (!message) return null;
    const session = this.db.select().from(agentSessions).where(eq(agentSessions.id, message.sessionId)).get();
    if (!session) return null;
    const title = session.title?.trim() || session.pageLabel || "对话";
    return {
      title,
      body: message.content ?? "",
      sourceKind: null,
      occurredAt: null,
      ingestedAt: message.createdAt,
      timeBasis: "ingested",
      fileVersionId: null,
      versionLabel: null,
      sessionId: message.sessionId,
    };
  }

  private loadDocument(refId: string): ItemMeta | null {
    const doc = this.db.select().from(documents).where(eq(documents.id, refId)).get();
    if (!doc || doc.deletedAt) return null;
    const body = doc.overviewText?.trim() ? doc.overviewText : this.extractPlainText(doc.contentJson);
    return {
      title: doc.title,
      body,
      sourceKind: doc.origin,
      occurredAt: null,
      ingestedAt: doc.createdAt,
      timeBasis: "ingested",
      fileVersionId: null,
      versionLabel: doc.version > 0 ? `v${doc.version}` : null,
      sessionId: null,
    };
  }

  /** contentJson 里的字符串值拼接为可检索正文（overview 未生成时的兜底）。 */
  private extractPlainText(contentJson: unknown, depth = 0): string {
    if (depth > 12 || contentJson === null || contentJson === undefined) return "";
    if (typeof contentJson === "string") return contentJson;
    if (typeof contentJson === "number" || typeof contentJson === "boolean") return "";
    if (Array.isArray(contentJson)) {
      return contentJson.map((item) => this.extractPlainText(item, depth + 1)).join(" ");
    }
    if (typeof contentJson === "object") {
      const record = contentJson as Record<string, unknown>;
      const preferred = ["text", "title", "content", "heading", "caption", "name"];
      const parts: string[] = [];
      for (const key of preferred) {
        if (typeof record[key] === "string") parts.push(record[key] as string);
      }
      for (const [key, value] of Object.entries(record)) {
        if (!preferred.includes(key)) parts.push(this.extractPlainText(value, depth + 1));
      }
      return parts.join(" ");
    }
    return "";
  }

  // ------------------------------------------------------------------- worker

  start(): void {
    if (this.timer) return;
    // 崩溃恢复：上次运行中的 job 重新可见。
    this.db.update(jobs).set({ status: "pending", updatedAt: new Date() }).where(and(
      inArray(jobs.type, [...SEARCH_WORKER_JOB_TYPES]),
      eq(jobs.status, "running"),
    )).run();
    this.timer = setInterval(() => void this.drain(), 2_000);
    this.timer.unref();
    // 首轮 drain 延后 2s：大库（jobs/parsed_contents 数百 MB）的同步回填会触发
    // FTS5 段合并，占住主线程数百毫秒——正好压在 HTTP 监听之后、manifest 写入
    // 之前，把网关 ready 和启动闪屏一起拖住。先让 ready 落定，回填随后开始。
    this.initialDrainTimer = setTimeout(() => {
      this.initialDrainTimer = null;
      void this.drain();
    }, 2_000);
    this.initialDrainTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.initialDrainTimer) clearTimeout(this.initialDrainTimer);
    this.initialDrainTimer = null;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      for (let processed = 0; processed < 200; processed += 1) {
        const job = this.nextRunnableJob();
        if (!job) break;
        this.process(job);
        // 批间让步，避免回填洪峰长时间占用主线程。
        if (processed > 0 && processed % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      // drain 由 void 调用（2s 一跳），漏接即未处理拒绝、直接杀死网关进程
      // （2026-10-17 排障：线上频繁死亡根因）。坏任务留在队首会卡轮次——
      // 记日志后照常放行下一轮，由上层 API 路由负责具体报错反馈。
      console.error("[search] index drain failed:", error);
    } finally {
      this.draining = false;
    }
  }

  private nextRunnableJob(): typeof jobs.$inferSelect | null {
    return this.db.select().from(jobs)
      .where(and(eq(jobs.status, "pending"), inArray(jobs.type, [...SEARCH_WORKER_JOB_TYPES])))
      .orderBy(
        sql`case when ${jobs.type} = ${SEARCH_INDEX_HIGH_JOB_TYPE} then 0 else 1 end`,
        asc(jobs.createdAt),
      )
      .limit(1).get() ?? null;
  }

  private process(job: typeof jobs.$inferSelect): void {
    const claimed = this.db.update(jobs).set({ status: "running", updatedAt: new Date() }).where(and(
      eq(jobs.id, job.id),
      eq(jobs.status, "pending"),
    )).run();
    if (claimed.changes !== 1) return;
    const payload = job.payload as SearchIndexJobPayload;
    try {
      const outcome = this.reindexItem(payload.itemType, payload.refId);
      this.db.update(jobs).set({ status: "completed", result: { outcome }, error: null, updatedAt: new Date() })
        .where(eq(jobs.id, job.id)).run();
    } catch (error) {
      const attempts = (payload.attempts ?? 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        this.db.update(jobs).set({
          status: "failed",
          error: { message: error instanceof Error ? error.message : String(error) },
          updatedAt: new Date(),
        }).where(eq(jobs.id, job.id)).run();
      } else {
        this.db.update(jobs).set({
          status: "pending",
          payload: { ...payload, attempts },
          updatedAt: new Date(),
        }).where(eq(jobs.id, job.id)).run();
      }
    }
  }

  // -------------------------------------------------------------------- query

  search(query: string, filters: SearchFilters, limit: number, offset: number): SearchPage {
    const trimmed = query.trim();
    const conditions: string[] = [];
    const params: unknown[] = [];

    const types = (filters.types ?? []).filter((t): t is SearchItemType => (ITEM_TYPES as readonly string[]).includes(t));
    if (types.length > 0) {
      conditions.push(`si.item_type IN (${types.map(() => "?").join(",")})`);
      params.push(...types);
    }
    if (filters.timeBasis && filters.from !== undefined && filters.to !== undefined) {
      // occurred 基准用 COALESCE：无发生时间的条目按收录时间参与（与展示口径一致）。
      const column = filters.timeBasis === "occurred" ? "COALESCE(si.occurred_at, si.ingested_at)" : "si.ingested_at";
      conditions.push(`${column} >= ? AND ${column} <= ?`);
      params.push(filters.from, filters.to);
    }

    let rows: IndexRow[];
    let totalRow: { count: number } | undefined;
    if (trimmed && isSingleCharQuery(trimmed)) {
      conditions.push(`si.title LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(trimmed)}%`);
      const whereClause = `WHERE ${conditions.join(" AND ")}`;
      rows = this.sqlite.prepare(
        `SELECT si.* FROM search_index si ${whereClause} ORDER BY si.ingested_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as IndexRow[];
      totalRow = this.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM search_index si ${whereClause}`,
      ).get(...params) as { count: number };
    } else if (trimmed) {
      const tokens = tokenizeJoined(trimmed);
      conditions.unshift("search_index_fts MATCH ?");
      params.unshift(tokens);
      const whereClause = `WHERE ${conditions.join(" AND ")}`;
      rows = this.sqlite.prepare(
        `SELECT si.* FROM search_index_fts f
         JOIN search_index si ON si.rowid = f.rowid
         ${whereClause} ORDER BY bm25(search_index_fts) LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as IndexRow[];
      totalRow = this.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM search_index_fts f JOIN search_index si ON si.rowid = f.rowid ${whereClause}`,
      ).get(...params) as { count: number };
    } else {
      // 空查询：按收录时间倒序列出（面板初始态/仅筛选时）。
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      rows = this.sqlite.prepare(
        `SELECT si.* FROM search_index si ${whereClause} ORDER BY si.ingested_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as IndexRow[];
      totalRow = this.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM search_index si ${whereClause}`,
      ).get(...params) as { count: number };
    }

    const pageIdsBySession = this.pageIdsForSessions(rows.filter((row) => row.item_type === "message" && row.session_id).map((row) => row.session_id!));
    return {
      items: rows.map((row) => this.toHit(
        row,
        trimmed,
        row.session_id ? pageIdsBySession.get(row.session_id) ?? null : null,
      )),
      total: totalRow?.count ?? rows.length,
      scope: this.status(),
    };
  }

  /** 消息命中的会话 pageLabel（渲染层跳转会话用；非 Agent 页返回 null 由渲染层兜底）。 */
  private pageIdsForSessions(sessionIds: string[]): Map<string, string> {
    const map = new Map<string, string>();
    if (sessionIds.length === 0) return map;
    const placeholders = sessionIds.map(() => "?").join(",");
    const rows = this.sqlite.prepare(
      `SELECT id, page_label FROM agent_sessions WHERE id IN (${placeholders})`,
    ).all(...sessionIds) as Array<{ id: string; page_label: string }>;
    for (const row of rows) map.set(row.id, row.page_label);
    return map;
  }

  private toHit(row: IndexRow, query: string, pageId: string | null): SearchHit {
    return {
      id: row.id,
      itemType: row.item_type,
      refId: row.ref_id,
      title: row.title,
      snippet: buildSnippet(row.body_preview, row.title, query),
      sourceKind: row.source_kind,
      // 恒为空：Room 维度已随 Phase 2i 删除，字段仅为桌面渲染契约保留。
      roomIds: [],
      occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
      ingestedAt: new Date(row.ingested_at).toISOString(),
      timeBasis: row.time_basis,
      versionLabel: row.version_label,
      fileVersionId: row.file_version_id,
      status: row.status,
      sessionId: row.session_id,
      pageId,
    };
  }

  status(): { indexedCount: number; pendingCount: number } {
    const indexed = this.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM search_index WHERE status != 'failed'",
    ).get() as { count: number };
    const pending = this.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE type IN (?, ?) AND status IN ('pending','running')",
    ).get(SEARCH_INDEX_JOB_TYPE, SEARCH_INDEX_HIGH_JOB_TYPE) as { count: number };
    return { indexedCount: indexed.count, pendingCount: pending.count };
  }

  /** 优先处理：把该条目排队中的 normal job 提为 high。 */
  prioritize(itemType: SearchItemType, refId: string): boolean {
    const id = `search-index:${itemType}:${refId}`;
    const changed = this.sqlite.prepare(
      "UPDATE jobs SET type=?, updated_at=? WHERE id=? AND type=? AND status='pending'",
    ).run(SEARCH_INDEX_HIGH_JOB_TYPE, Date.now(), id, SEARCH_INDEX_JOB_TYPE);
    if (changed.changes === 0) {
      enqueueSearchIndex(this.db, { itemType, refId, priority: "high" });
    }
    void this.drain();
    return true;
  }

  /** 对话结果展开：同会话前后消息（含命中消息本体）。 */
  messageContext(messageId: string, before: number, after: number): {
    sessionId: string;
    messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
  } | null {
    const anchor = this.db.select().from(agentMessages).where(eq(agentMessages.id, messageId)).get();
    if (!anchor) return null;
    const all = this.db.select({
      id: agentMessages.id,
      role: agentMessages.role,
      content: agentMessages.content,
      createdAt: agentMessages.createdAt,
    }).from(agentMessages)
      .where(eq(agentMessages.sessionId, anchor.sessionId))
      .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id))
      .all();
    const anchorIndex = all.findIndex((m) => m.id === messageId);
    if (anchorIndex < 0) return null;
    const start = Math.max(0, anchorIndex - before);
    const end = Math.min(all.length, anchorIndex + after + 1);
    return {
      sessionId: anchor.sessionId,
      messages: all.slice(start, end).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content ?? "",
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 摘要：定位首个命中词，取前后窗口；无正文或未命中取正文开头/标题。 */
function buildSnippet(bodyPreview: string, title: string, query: string): string {
  const source = bodyPreview.trim() || title;
  if (!source) return "";
  const flat = source.replace(/\s+/g, " ");
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let index = -1;
  for (const term of terms) {
    const found = flat.toLowerCase().indexOf(term);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) return flat.slice(0, SNIPPET_WINDOW);
  const start = Math.max(0, index - 48);
  return flat.slice(start, start + SNIPPET_WINDOW);
}
