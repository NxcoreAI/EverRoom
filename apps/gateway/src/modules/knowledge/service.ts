import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DocumentEvent, RoomDocument } from "@nxcore/agent-contract";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { KnowledgeLlmConfig } from "../../config.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  documents,
  gatewayMetadata,
  jobs,
  parsedContents,
  roomDocumentLinks,
  roomWikis,
  routeDecisions,
  routingRules,
  rooms,
  uploadedFiles,
} from "../../infrastructure/database/schema.js";
import { advanceCentroid, EmbeddingClient, embeddingInputText } from "./embedding.js";
import { buildDocumentEnvelope, envelopeFilename, type DocEnvelope } from "./envelope.js";
import { convertUploadedFile } from "./file-convert.js";
import {
  contentHashOf,
  fileIdOf,
  MARKDOWN_PARSER_VERSION,
  storageRelPath,
  storeFileBlob,
} from "./file-storage.js";
import { KnowledgeLlm } from "./llm.js";
import { KsAdminClient, KsBusyError, type KsWikiPageItem } from "./ks-client.js";
import { RoomWikiRegistry } from "./registry.js";
import { KnowledgeRouter, type NewRoomProposal } from "./router.js";
import { WikiPageIndex } from "./wiki-index.js";

export interface KnowledgeServiceConfig {
  baseUrl: string;
  serviceId: string;
  teamId: string;
  /** gateway dataDir：上传文件对象库（files/sha256/…）的根。 */
  dataDir: string;
  /** Room 级 wiki 总开关（NXCORE_KNOWLEDGE_ROOM_WIKIS_ENABLED）。 */
  roomWikisEnabled: boolean;
  /** 文档落定后的入队防抖窗口（plan §5.1，默认 10 分钟）。 */
  ingestDebounceMs: number;
  /** 自动归类路由总开关（NXCORE_KNOWLEDGE_ROUTER_ENABLED）。 */
  routerEnabled: boolean;
  routeThresholdAuto: number;
  routeThresholdReview: number;
  autoCreateRoomEnabled: boolean;
  /** ⑤ LLM 仲裁端点；null = M1 形态（人工即仲裁者）。 */
  llm: KnowledgeLlmConfig | null;
  /** ④ embedding 端点；null 或 embeddingModel 空 = 关闭向量层。 */
  embeddingLlm: KnowledgeLlmConfig | null;
  embeddingModel: string;
}

export interface KnowledgeServiceLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

const INGEST_JOB_TYPE = "knowledge.ingest";
const ROUTE_JOB_TYPE = "knowledge.route";
const CLEANUP_JOB_TYPE = "knowledge.cleanup";
/** ingest 完成轮询 / get 的间隔与总超时（plan §5.3 步骤 5）。 */
const INGEST_POLL_INTERVAL_MS = 2_000;
const INGEST_POLL_TIMEOUT_MS = 10 * 60_000;
/** 409 busy / 瞬时不可达的退避间隔与最大尝试次数。 */
const BUSY_RETRY_DELAY_MS = 5_000;
const MAX_TRANSIENT_ATTEMPTS = 5;
/** 待归类队列单页上限。 */
const PENDING_PAGE_SIZE = 100;

interface IngestJobPayload {
  sourceKind: DocEnvelope["ref"]["kind"];
  sourceId: string;
  sourceVersion: number;
  roomId: string;
  decisionId: string;
}

interface RouteJobPayload {
  sourceKind: DocEnvelope["ref"]["kind"];
  sourceId: string;
  sourceVersion: number;
  /** revert 后重路由：跳过 ①，否则同 Room 直连死循环（plan §5.5）。 */
  skipEntry?: boolean;
  /** 外部信封（连接器契约）：无表可查时的路由直接输入。 */
  envelope?: {
    title: string;
    markdown: string;
    occurredAt?: string;
    entrySignals?: DocEnvelope["entrySignals"];
  };
}

interface CleanupJobPayload {
  sourceKind: DocEnvelope["ref"]["kind"];
  sourceId: string;
}

interface PendingSchedule {
  timer: NodeJS.Timeout;
  version: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Knowledge 路由与 ingest 编排（docs/room-wiki-plan.md §5）。
 *
 * routerEnabled=false：M0 行为——① 入口直连（EverRoom 内文档天然带
 * roomId，confidence=1 直连 ingest）。
 * routerEnabled=true：commit → 防抖 → route job → 完整瀑布
 * （②a/②b/③/④/⑤）→ execute 则派生 ingest job，review 则留待归类。
 *
 * worker 约束：per-room 串行（KS /ingest 并发 409），busy 退避重试；
 * 决策记 route_decisions 流水（evidence 携带 raw 文件名，清理时溯源）。
 */
export class KnowledgeService {
  private readonly ks: KsAdminClient;
  private readonly registry: RoomWikiRegistry;
  private readonly wikiIndex: WikiPageIndex;
  private readonly router: KnowledgeRouter;
  private readonly llm: KnowledgeLlm | null;
  private readonly embedding: { client: EmbeddingClient; model: string } | null;
  private readonly pendingSchedules = new Map<string, PendingSchedule>();
  private readonly busyRoomKeys = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private readonly transientAttempts = new Map<string, number>();
  private drainTimer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly config: KnowledgeServiceConfig,
    private readonly logger: KnowledgeServiceLogger,
  ) {
    this.ks = new KsAdminClient({
      baseUrl: config.baseUrl,
      serviceId: config.serviceId,
      teamId: config.teamId,
    });
    this.registry = new RoomWikiRegistry(this.db, this.ks);
    this.wikiIndex = new WikiPageIndex(this.db, this.ks);
    this.llm = config.llm ? new KnowledgeLlm(config.llm) : null;
    this.embedding = config.embeddingLlm && config.embeddingModel
      ? { client: new EmbeddingClient(config.embeddingLlm, config.embeddingModel), model: config.embeddingModel }
      : null;
    this.router = new KnowledgeRouter({
      db,
      wikiIndex: this.wikiIndex,
      llm: this.llm,
      embedding: this.embedding,
      thresholds: {
        auto: config.routeThresholdAuto,
        review: config.routeThresholdReview,
        autoCreateRoomEnabled: config.autoCreateRoomEnabled,
      },
      logger: { warn: (bindings, message) => this.logger.warn(bindings, message) },
    });
  }

  /** supervisor 生命周期钩子：启动 worker 轮询。 */
  start(): void {
    // 存量 file 决策迁移到确定性身份（一次性，失败不阻塞启动）
    void this.backfillUploadedFiles().catch((error) => {
      this.logger.error(
        { event: "knowledge.files.backfill_failed", error: error instanceof Error ? error.message : String(error) },
        "uploaded files backfill failed",
      );
    });
    if (this.drainTimer || !this.config.roomWikisEnabled) return;
    this.drainTimer = setInterval(() => void this.drain(), 1_000);
    this.drainTimer.unref();
    void this.drain();
  }

  dispose(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
    for (const schedule of this.pendingSchedules.values()) clearTimeout(schedule.timer);
    this.pendingSchedules.clear();
  }

  /** Room 当前 wiki 解析（会话级挂载用，plan §6.1）。 */
  resolveRoomWikiId(roomId: string): string | null {
    return this.registry.resolveRoomWikiId(roomId);
  }

  /** 路由开关透出（REST 层据此决定外部信封入口是否可用）。 */
  get routerEnabled(): boolean {
    return this.config.routerEnabled;
  }

  listRoomWikis(): Array<{ roomId: string; knowledgeId: string; status: string; createdAt: Date }> {
    return this.registry.listRoomWikis();
  }

  // ───────────────────────── Wiki 页面读取（渲染器 Wiki Tab 数据源） ─────────────────────────

  /**
   * Room wiki 页面清单 + 处理状态（processing 徽标，plan §10 竞态对策）。
   * Room 尚无 wiki（懒创建未触发）返回 status="none"，Tab 显示"尚无沉淀"。
   */
  async listRoomWikiPages(roomId: string): Promise<{ status: string; items: KsWikiPageItem[]; pageCount: number | null }> {
    const knowledgeId = this.registry.resolveRoomWikiId(roomId);
    if (!knowledgeId) return { status: "none", items: [], pageCount: null };
    const wiki = await this.ks.getWiki(knowledgeId);
    if (!wiki) return { status: "none", items: [], pageCount: null };
    const items = await this.ks.listPages(knowledgeId);
    // page_count：KS 内部已产出页数（processing 期间 ls 为空，用它透出构建进度）
    return { status: wiki.status, items, pageCount: wiki.page_count };
  }

  /** 读单页 Markdown 全文（ref = page/ls 的 path）；无 wiki 或页面缺失返回 null。 */
  async readRoomWikiPage(roomId: string, ref: string): Promise<string | null> {
    const knowledgeId = this.registry.resolveRoomWikiId(roomId);
    if (!knowledgeId) return null;
    const item = await this.ks.readPage(knowledgeId, ref);
    if (!item || item.not_found) return null;
    return item.content ?? "";
  }

  /**
   * Room 的上传文件清单（资料单一查询面，file 部分）：
   * 先筛 primary_room_id = roomId 再取每 file_id 最新一条——新版本重传后
   * 会出现无归属的 awaiting 行，不能让它把文件从原 Room 清单里挤掉。
   */
  listRoomFiles(roomId: string): Array<{
    id: string;
    originalName: string;
    bytes: number;
    title: string | null;
    status: string;
    decidedBy: string | null;
    confidence: number | null;
    uploadedAt: Date;
  }> {
    const decisions = this.db.select().from(routeDecisions)
      .where(and(eq(routeDecisions.sourceKind, "file"), eq(routeDecisions.primaryRoomId, roomId)))
      .orderBy(desc(routeDecisions.createdAt))
      .all();
    const latestBySource = new Map<string, typeof decisions[number]>();
    for (const decision of decisions) {
      if (!latestBySource.has(decision.sourceId)) latestBySource.set(decision.sourceId, decision);
    }
    const wanted = [...latestBySource.values()];
    if (wanted.length === 0) return [];
    const fileRows = this.db.select().from(uploadedFiles)
      .where(inArray(uploadedFiles.id, wanted.map((decision) => decision.sourceId)))
      .all();
    const filesById = new Map(fileRows.map((row) => [row.id, row]));
    return wanted
      .map((decision) => {
        const file = filesById.get(decision.sourceId);
        if (!file) return null;
        return {
          id: file.id,
          originalName: file.originalName,
          bytes: file.bytes,
          title: decision.sourceTitle,
          status: decision.status,
          decidedBy: decision.decidedBy,
          confidence: decision.confidence ?? null,
          uploadedAt: file.createdAt,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }

  /** 文件当前解析产物的 markdown（预览用）；无文件或未解析返回 null。 */
  readFileMarkdown(fileId: string): string | null {
    const file = this.db.select().from(uploadedFiles).where(eq(uploadedFiles.id, fileId)).get();
    if (!file?.currentParsedId) return null;
    const parsed = this.db.select().from(parsedContents)
      .where(eq(parsedContents.id, file.currentParsedId)).get();
    return parsed?.markdown ?? null;
  }

  /** 文件本体的绝对路径（主进程 reveal 用）；无文件返回 null。 */
  fileStoragePath(fileId: string): string | null {
    const file = this.db.select().from(uploadedFiles).where(eq(uploadedFiles.id, fileId)).get();
    return file ? join(this.config.dataDir, file.storagePath) : null;
  }

  // ───────────────────────── 文档事件入口（① 层） ─────────────────────────

  /** documents 模块事件回调：committed/updated 触发防抖入队，deleted 触发清理。 */
  handleDocumentEvent(event: DocumentEvent): void {
    if (!this.config.roomWikisEnabled) return;
    switch (event.type) {
      case "document.committed":
      case "document.updated": {
        const document = (event.payload as { document?: RoomDocument }).document;
        if (document && document.version > 0) this.scheduleIngest(document);
        break;
      }
      case "document.deleted": {
        const schedule = this.pendingSchedules.get(event.documentId);
        if (schedule) {
          clearTimeout(schedule.timer);
          this.pendingSchedules.delete(event.documentId);
        }
        this.enqueueCleanup("everroom-doc", event.documentId);
        break;
      }
      default:
        break;
    }
  }

  /**
   * 防抖（plan §5.1）：同一文档窗口内多次 commit/save 只入队最后一次。
   * 版本单调性兜底：低版本事件不重置已排定的更高版本。
   */
  private scheduleIngest(document: RoomDocument): void {
    const existing = this.pendingSchedules.get(document.id);
    if (existing && document.version <= existing.version) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pendingSchedules.delete(document.id);
      this.enqueueFromDocument(document.id);
    }, this.config.ingestDebounceMs);
    timer.unref();
    this.pendingSchedules.set(document.id, { timer, version: document.version });
  }

  /** 手动"立即沉淀"入口（REST route/manual）：绕过防抖直接入队。 */
  routeDocumentNow(documentId: string): { queued: boolean; roomId: string | null } {
    const target = this.getDocumentWithRoom(documentId);
    if (!target) return { queued: false, roomId: null };
    this.enqueueFromDocument(documentId);
    return { queued: true, roomId: target.roomId };
  }

  private getDocumentWithRoom(documentId: string): { document: RoomDocument; roomId: string } | null {
    const row = this.db.select({ document: documents, roomId: roomDocumentLinks.roomId })
      .from(documents)
      .innerJoin(roomDocumentLinks, eq(roomDocumentLinks.documentId, documents.id))
      .where(eq(documents.id, documentId))
      .orderBy(asc(roomDocumentLinks.linkedAt))
      .get();
    if (!row) return null;
    return { document: this.toRoomDocument(row.document, row.roomId), roomId: row.roomId };
  }

  private getDocument(documentId: string): RoomDocument | null {
    const row = this.db.select().from(documents).where(eq(documents.id, documentId)).get();
    if (!row) return null;
    return this.toRoomDocument(row, null);
  }

  /**
   * @param roomId 文档的 Room 语境：执行/路由时由调用方指定（信封 frontmatter
   *   的 room 字段写目标 Room）；无链接语境时置空串，不虚构归属。
   */
  private toRoomDocument(row: typeof documents.$inferSelect, roomId: string | null): RoomDocument {
    return {
      id: row.id,
      roomId: roomId ?? "",
      title: row.title,
      contentJson: row.contentJson as RoomDocument["contentJson"],
      version: row.version,
      status: row.status,
      activeTransactionId: row.activeTransactionId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** 防抖到点 / 手动触发：按 router 开关走瀑布或 M0 直连。 */
  private enqueueFromDocument(documentId: string): void {
    const target = this.getDocumentWithRoom(documentId);
    if (!target) return;
    if (this.config.routerEnabled) {
      const payload: RouteJobPayload = {
        sourceKind: "everroom-doc",
        sourceId: target.document.id,
        sourceVersion: target.document.version,
      };
      this.insertJob(ROUTE_JOB_TYPE, payload);
      this.wake();
      return;
    }
    this.enqueueEntryIngest(target.document, target.roomId);
  }

  /** M0 路径（router 关闭）：① 入口决策 + ingest job 一步到位。 */
  private enqueueEntryIngest(document: RoomDocument, roomId: string): void {
    const decisionId = randomUUID();
    this.db.insert(routeDecisions).values({
      id: decisionId,
      sourceKind: "everroom-doc",
      sourceId: document.id,
      sourceVersion: document.version,
      primaryRoomId: roomId,
      confidence: 1,
      decidedBy: "entry",
      reason: "文档创建于该 Room（入口确定性）",
      status: "auto",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();
    const payload: IngestJobPayload = {
      sourceKind: "everroom-doc",
      sourceId: document.id,
      sourceVersion: document.version,
      roomId,
      decisionId,
    };
    this.insertJob(INGEST_JOB_TYPE, payload);
    this.wake();
  }

  /** 外部信封入口（route/manual 全量信封）：router 必须开启。 */
  submitEnvelope(input: {
    sourceKind: DocEnvelope["ref"]["kind"];
    title: string;
    markdown: string;
    occurredAt?: string;
    entrySignals?: DocEnvelope["entrySignals"];
    sourceId?: string;
    sourceVersion?: number;
  }): { queued: boolean } {
    const payload: RouteJobPayload = {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId ?? `ext-${randomUUID().slice(0, 12)}`,
      sourceVersion: input.sourceVersion ?? 1,
      envelope: {
        title: input.title,
        markdown: input.markdown,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        ...(input.entrySignals ? { entrySignals: input.entrySignals } : {}),
      },
    };
    this.insertJob(ROUTE_JOB_TYPE, payload);
    this.wake();
    return { queued: true };
  }

  /**
   * 上传文件入口（用户主路径：拖个文件进来 → 自动归类进 Room）。
   * 四道判重闸门的前两道在此：闸1 同名同内容 → 全跳过（零成本）；
   * 同名新内容 → 版本更新（同 sourceId，②a 回原 Room + KS 同名覆盖）。
   * 本体落对象库，md 落 parsed_contents，route_decisions 只留决策流水。
   */
  async submitFileUpload(input: {
    filename: string;
    buffer: Buffer;
    occurredAt?: string;
    entrySignals?: DocEnvelope["entrySignals"];
  }): Promise<{ queued: boolean; sourceId: string; title: string; deduped: boolean }> {
    const converted = convertUploadedFile(input.filename, input.buffer);
    const sourceId = fileIdOf(input.filename);
    const contentHash = contentHashOf(input.buffer);

    const existing = this.db.select().from(uploadedFiles).where(eq(uploadedFiles.id, sourceId)).get();
    if (existing?.contentHash === contentHash) {
      // 闸1：同名且内容未变——不存、不解析、不入队（闸3 归属必然没变）
      this.logger.info(
        { event: "knowledge.file.deduped", sourceId, filename: input.filename },
        "file re-upload with unchanged content skipped",
      );
      return { queued: false, sourceId, title: existing.originalName, deduped: true };
    }

    await storeFileBlob(this.config.dataDir, contentHash, input.buffer);
    const parsedId = this.ensureParsed(contentHash, converted.markdown);

    if (existing) {
      // 版本更新：身份不变，指针前移；路由走 ②a 链接回原 Room
      this.db.update(uploadedFiles).set({
        contentHash,
        storagePath: storageRelPath(contentHash),
        originalName: input.filename,
        bytes: input.buffer.byteLength,
        currentParsedId: parsedId,
        updatedAt: new Date(),
      }).where(eq(uploadedFiles.id, sourceId)).run();
    } else {
      this.db.insert(uploadedFiles).values({
        id: sourceId,
        contentHash,
        storagePath: storageRelPath(contentHash),
        originalName: input.filename,
        bytes: input.buffer.byteLength,
        currentParsedId: parsedId,
      }).onConflictDoNothing().run();
    }

    const sourceVersion = this.nextFileVersion(sourceId);
    this.submitEnvelope({
      sourceKind: "file",
      sourceId,
      sourceVersion,
      title: converted.title,
      markdown: converted.markdown,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      // 文件名进 ②b 规则信号（如 "发票-" 前缀规则）；用户显式传的字段优先
      entrySignals: {
        filenamePrefix: input.filename,
        ...(input.entrySignals ?? {}),
      },
    });
    this.logger.info(
      { event: "knowledge.file.uploaded", sourceId, filename: input.filename, bytes: input.buffer.byteLength, version: sourceVersion },
      existing ? "file version updated for routing" : "file uploaded for routing",
    );
    return { queued: true, sourceId, title: converted.title, deduped: false };
  }

  /** 闸2：解析产物幂等入库，(hash, parser_version) 已有则直接复用。 */
  private ensureParsed(contentHash: string, markdown: string): string {
    const existing = this.db.select().from(parsedContents)
      .where(and(
        eq(parsedContents.contentHash, contentHash),
        eq(parsedContents.parserVersion, MARKDOWN_PARSER_VERSION),
      ))
      .get();
    if (existing) return existing.id;
    const id = `parsed-${randomUUID().slice(0, 12)}`;
    this.db.insert(parsedContents).values({
      id,
      contentHash,
      parserVersion: MARKDOWN_PARSER_VERSION,
      markdown,
    }).run();
    return id;
  }

  /** file 的下一个版本号：取该源已有决策的最大 source_version + 1。 */
  private nextFileVersion(sourceId: string): number {
    const rows = this.db.select({ sourceVersion: routeDecisions.sourceVersion })
      .from(routeDecisions)
      .where(and(eq(routeDecisions.sourceKind, "file"), eq(routeDecisions.sourceId, sourceId)))
      .orderBy(desc(routeDecisions.sourceVersion))
      .limit(1)
      .all();
    return (rows[0]?.sourceVersion ?? 0) + 1;
  }

  /**
   * 存量回填（一次性，gateway_metadata 打标）：旧随机 sourceId 的 file
   * 决策改写为确定性 ID，快照 markdown 补落 parsed、字节补落对象库，
   * 让既有资料进入新身份体系（重传即可被闸 1/闸 3 认出）。
   */
  private async backfillUploadedFiles(): Promise<void> {
    const flag = this.db.select().from(gatewayMetadata)
      .where(eq(gatewayMetadata.key, "knowledge.files_backfill_v1")).get();
    if (flag) return;

    const rows = this.db.select({
      sourceId: routeDecisions.sourceId,
      sourceTitle: routeDecisions.sourceTitle,
      sourceMarkdown: routeDecisions.sourceMarkdown,
      createdAt: routeDecisions.createdAt,
    }).from(routeDecisions)
      .where(eq(routeDecisions.sourceKind, "file"))
      .orderBy(asc(routeDecisions.createdAt))
      .all();

    // 每个旧 sourceId 取最新一份快照（重传场景后写的覆盖先写的）
    const latestByLegacyId = new Map<string, { title: string; markdown: string }>();
    for (const row of rows) {
      if (!row.sourceTitle || row.sourceMarkdown == null) continue;
      latestByLegacyId.set(row.sourceId, { title: row.sourceTitle, markdown: row.sourceMarkdown });
    }

    let migrated = 0;
    for (const [legacyId, snapshot] of latestByLegacyId) {
      const originalName = /\.md$/i.test(snapshot.title) ? snapshot.title : `${snapshot.title}.md`;
      const fileId = fileIdOf(originalName);
      const buffer = Buffer.from(snapshot.markdown, "utf8");
      const contentHash = contentHashOf(buffer);
      try {
        await storeFileBlob(this.config.dataDir, contentHash, buffer);
      } catch (error) {
        this.logger.warn(
          { event: "knowledge.files.backfill_blob_failed", legacyId, error: error instanceof Error ? error.message : String(error) },
          "backfill blob write failed, row skipped",
        );
        continue;
      }
      const parsedId = this.ensureParsed(contentHash, snapshot.markdown);
      this.db.insert(uploadedFiles).values({
        id: fileId,
        contentHash,
        storagePath: storageRelPath(contentHash),
        originalName,
        bytes: buffer.byteLength,
        currentParsedId: parsedId,
      }).onConflictDoNothing().run();
      this.db.update(routeDecisions)
        .set({ sourceId: fileId, updatedAt: new Date() })
        .where(and(eq(routeDecisions.sourceKind, "file"), eq(routeDecisions.sourceId, legacyId)))
        .run();
      migrated += 1;
    }

    this.db.insert(gatewayMetadata).values({
      key: "knowledge.files_backfill_v1",
      value: JSON.stringify({ migrated, at: new Date().toISOString() }),
    }).onConflictDoNothing().run();
    if (migrated > 0) {
      this.logger.info(
        { event: "knowledge.files.backfilled", migrated },
        "legacy file decisions migrated to deterministic ids",
      );
    }
  }

  private enqueueCleanup(sourceKind: CleanupJobPayload["sourceKind"], sourceId: string): void {
    const payload: CleanupJobPayload = { sourceKind, sourceId };
    this.insertJob(CLEANUP_JOB_TYPE, payload);
    this.wake();
  }

  private insertJob(type: string, payload: IngestJobPayload | RouteJobPayload | CleanupJobPayload): string {
    const id = randomUUID();
    this.db.insert(jobs).values({ id, type, status: "pending", payload }).run();
    this.logger.info({ event: "knowledge.job.enqueued", jobId: id, type }, `knowledge job enqueued: ${type}`);
    return id;
  }

  private wake(): void {
    void this.drain();
  }

  // ───────────────────────── worker（plan §5.3） ─────────────────────────

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const candidates = this.db.select().from(jobs)
        .where(and(
          eq(jobs.status, "pending"),
          inArray(jobs.type, [INGEST_JOB_TYPE, ROUTE_JOB_TYPE, CLEANUP_JOB_TYPE]),
        ))
        .orderBy(asc(jobs.createdAt))
        .all();
      const now = Date.now();
      for (const job of candidates) {
        const retryAt = this.retryAfter.get(job.id);
        if (retryAt && retryAt > now) continue;
        const lockKey = this.lockKeyOf(job);
        if (lockKey && this.busyRoomKeys.has(lockKey)) continue;
        await this.processJob(job, lockKey);
      }
    } catch (error) {
      this.logger.error(
        { event: "knowledge.worker.error", error: error instanceof Error ? error.message : String(error) },
        "knowledge worker drain failed",
      );
    } finally {
      this.draining = false;
    }
  }

  /** per-room 串行的锁键：ingest 用 roomId（wiki 1:1 Room），route/cleanup 无锁。 */
  private lockKeyOf(job: typeof jobs.$inferSelect): string | null {
    if (job.type !== INGEST_JOB_TYPE) return null;
    const payload = job.payload as IngestJobPayload;
    return payload.roomId;
  }

  private async processJob(job: typeof jobs.$inferSelect, lockKey: string | null): Promise<void> {
    if (lockKey) this.busyRoomKeys.add(lockKey);
    this.db.update(jobs).set({ status: "running", updatedAt: new Date() })
      .where(eq(jobs.id, job.id)).run();
    try {
      if (job.type === INGEST_JOB_TYPE) {
        await this.runIngestJob(job.payload as IngestJobPayload);
      } else if (job.type === ROUTE_JOB_TYPE) {
        await this.runRouteJob(job.payload as RouteJobPayload);
      } else {
        await this.runCleanupJob(job.payload as CleanupJobPayload);
      }
      this.db.update(jobs).set({ status: "completed", updatedAt: new Date() }).where(eq(jobs.id, job.id)).run();
      this.retryAfter.delete(job.id);
      this.transientAttempts.delete(job.id);
    } catch (error) {
      if (error instanceof KsBusyError) {
        // 409 busy：回 pending 退避重试（per-wiki 串行约束的来源）。
        this.db.update(jobs).set({ status: "pending", updatedAt: new Date() }).where(eq(jobs.id, job.id)).run();
        this.retryAfter.set(job.id, Date.now() + BUSY_RETRY_DELAY_MS);
      } else {
        const attempts = (this.transientAttempts.get(job.id) ?? 0) + 1;
        const message = error instanceof Error ? error.message : String(error);
        if (attempts < MAX_TRANSIENT_ATTEMPTS) {
          this.db.update(jobs).set({ status: "pending", updatedAt: new Date() }).where(eq(jobs.id, job.id)).run();
          this.retryAfter.set(job.id, Date.now() + BUSY_RETRY_DELAY_MS * attempts);
          this.transientAttempts.set(job.id, attempts);
          this.logger.warn(
            { event: "knowledge.job.retry", jobId: job.id, attempts, error: message },
            "knowledge job failed, scheduled retry",
          );
        } else {
          this.db.update(jobs).set({
            status: "failed",
            error: { message },
            updatedAt: new Date(),
          }).where(eq(jobs.id, job.id)).run();
          this.transientAttempts.delete(job.id);
          this.logger.error(
            { event: "knowledge.job.failed", jobId: job.id, error: message },
            "knowledge job failed permanently",
          );
        }
      }
    } finally {
      if (lockKey) this.busyRoomKeys.delete(lockKey);
    }
  }

  /** route job：重建信封 → 瀑布 → execute 则派生 ingest job。 */
  private async runRouteJob(payload: RouteJobPayload): Promise<void> {
    let envelope: DocEnvelope | null = null;
    if (payload.envelope) {
      const { occurredAt, entrySignals, ...rest } = payload.envelope;
      envelope = {
        ref: { kind: payload.sourceKind, id: payload.sourceId, version: payload.sourceVersion },
        ...rest,
        ...(occurredAt ? { occurredAt } : {}),
        ...(entrySignals ? { entrySignals } : {}),
      };
    } else if (payload.sourceKind === "everroom-doc") {
      const document = this.getDocument(payload.sourceId);
      if (!document) return; // 文档已删除：cleanup job 负责 wiki 侧
      if (document.version !== payload.sourceVersion) return; // 已被更新版本取代
      envelope = buildDocumentEnvelope(document);
    }
    if (!envelope) {
      this.logger.warn(
        { event: "knowledge.route.noenvelope", sourceKind: payload.sourceKind, sourceId: payload.sourceId },
        "route job has no envelope source, skipping",
      );
      return;
    }

    const result = await this.router.route(envelope, { skipEntry: payload.skipEntry ?? false });
    if (result.disposition === "execute" && result.roomId) {
      this.insertJob(INGEST_JOB_TYPE, {
        sourceKind: envelope.ref.kind,
        sourceId: envelope.ref.id,
        sourceVersion: envelope.ref.version,
        roomId: result.roomId,
        decisionId: result.decisionId,
      });
    }
    this.logger.info(
      {
        event: "knowledge.route.decided",
        sourceId: envelope.ref.id,
        disposition: result.disposition,
        decidedBy: result.decidedBy,
        roomId: result.roomId,
        confidence: result.confidence,
      },
      `route decision: ${result.disposition}`,
    );
  }

  private async runIngestJob(payload: IngestJobPayload): Promise<void> {
    const decision = this.db.select().from(routeDecisions)
      .where(eq(routeDecisions.id, payload.decisionId)).get();
    if (!decision) return; // 决策被清理：无可执行

    const envelope = await this.buildExecutionEnvelope(payload, decision);
    if (!envelope) return;

    const knowledgeId = await this.registry.ensureWikiForRoom(payload.roomId);
    const filename = envelopeFilename(envelope);

    await this.ks.rawWrite(knowledgeId, [{ filename, content: envelope.markdown }]);
    await this.ks.ingest(knowledgeId);
    await this.waitUntilSettled(knowledgeId);

    this.db.update(routeDecisions).set({
      status: "confirmed",
      evidence: { filename, knowledgeId },
      updatedAt: new Date(),
    }).where(eq(routeDecisions.id, payload.decisionId)).run();

    // 多归属附带链接（D3：多归属只 ingest 一次，其余 Room 仅写链接）
    const linkedRoomIds = decision.linkedRoomIds ?? [];
    if (envelope.ref.kind === "everroom-doc" && linkedRoomIds.length > 0) {
      for (const roomId of linkedRoomIds) {
        this.db.insert(roomDocumentLinks).values({
          roomId,
          documentId: envelope.ref.id,
          linkedAt: new Date(),
        }).onConflictDoNothing().run();
      }
    }

    // ③ 层标题缓存失效重拉 + ④ 质心推进（均 best-effort）
    this.wikiIndex.invalidate(knowledgeId);
    await this.advanceRoomCentroid(payload.roomId, knowledgeId, envelope);

    this.logger.info(
      { event: "knowledge.ingest.confirmed", sourceId: payload.sourceId, roomId: payload.roomId, knowledgeId },
      "document ingested into room wiki",
    );
  }

  /** 执行时还原信封：everroom-doc 回查 documents（版本校验），外部源取决策快照。 */
  private buildExecutionEnvelope(
    payload: IngestJobPayload,
    decision: typeof routeDecisions.$inferSelect,
  ): DocEnvelope | null {
    if (payload.sourceKind === "everroom-doc") {
      const document = this.getDocument(payload.sourceId);
      if (!document) return null; // 已删除：cleanup job 负责
      if (document.version !== payload.sourceVersion) {
        this.logger.info(
          { event: "knowledge.job.superseded", sourceId: payload.sourceId, jobVersion: payload.sourceVersion, currentVersion: document.version },
          "ingest job superseded by newer document version",
        );
        return null;
      }
      // frontmatter 的 room 写执行目标（⑤/确认可能路由到非源 Room）
      return buildDocumentEnvelope({ ...document, roomId: payload.roomId });
    }
    if (!decision.sourceMarkdown) {
      this.logger.warn(
        { event: "knowledge.job.nosnapshot", sourceId: payload.sourceId },
        "external decision missing markdown snapshot",
      );
      return null;
    }
    return {
      ref: { kind: payload.sourceKind, id: payload.sourceId, version: payload.sourceVersion },
      title: decision.sourceTitle ?? payload.sourceId,
      markdown: decision.sourceMarkdown,
    };
  }

  /** ④ 质心 EMA 推进（plan §5.2）：失败只记日志，不影响 ingest 结果。 */
  private async advanceRoomCentroid(roomId: string, knowledgeId: string, envelope: DocEnvelope): Promise<void> {
    if (!this.embedding) return;
    try {
      const vector = await this.embedding.client.embed(
        embeddingInputText(envelope.title, envelope.markdown),
      );
      const row = this.db.select().from(roomWikis).where(eq(roomWikis.roomId, roomId)).get();
      if (!row || row.knowledgeId !== knowledgeId) return;
      const advanced = advanceCentroid(
        { roomId, knowledgeId, centroid: row.centroid, centroidDocs: row.centroidDocs, centroidModel: row.centroidModel },
        vector,
        this.embedding.model,
      );
      this.db.update(roomWikis).set(advanced).where(eq(roomWikis.roomId, roomId)).run();
    } catch (error) {
      this.logger.warn(
        { event: "knowledge.centroid.failed", roomId, error: error instanceof Error ? error.message : String(error) },
        "centroid advance failed (non-fatal)",
      );
    }
  }

  private async runCleanupJob(payload: CleanupJobPayload): Promise<void> {
    const decisions = this.db.select().from(routeDecisions)
      .where(and(
        eq(routeDecisions.sourceKind, payload.sourceKind),
        eq(routeDecisions.sourceId, payload.sourceId),
        eq(routeDecisions.status, "confirmed"),
      ))
      .orderBy(desc(routeDecisions.createdAt))
      .all();
    if (decisions.length === 0) return;

    const handledRooms = new Set<string>();
    for (const decision of decisions) {
      if (!decision.primaryRoomId || handledRooms.has(decision.primaryRoomId)) continue;
      handledRooms.add(decision.primaryRoomId);
      const evidence = (decision.evidence ?? {}) as { filename?: string; knowledgeId?: string };
      const knowledgeId = this.registry.resolveRoomWikiId(decision.primaryRoomId);
      if (!evidence.filename || !knowledgeId) continue;
      await this.ks.rawRm(knowledgeId, [evidence.filename]);
      await this.ks.ingest(knowledgeId);
      await this.waitUntilSettled(knowledgeId);
    }
    this.db.update(routeDecisions).set({ status: "reverted", updatedAt: new Date() })
      .where(and(
        eq(routeDecisions.sourceKind, payload.sourceKind),
        eq(routeDecisions.sourceId, payload.sourceId),
        eq(routeDecisions.status, "confirmed"),
      ))
      .run();
    this.logger.info(
      { event: "knowledge.cleanup.done", sourceId: payload.sourceId, rooms: [...handledRooms] },
      "document removed from room wikis",
    );
  }

  /** 轮询 /v3/wiki/get 直到 ingest 落定（ready/failed/draft）。 */
  private async waitUntilSettled(knowledgeId: string): Promise<void> {
    const deadline = Date.now() + INGEST_POLL_TIMEOUT_MS;
    for (;;) {
      const wiki = await this.ks.getWiki(knowledgeId);
      if (!wiki) throw new Error(`wiki disappeared during ingest: ${knowledgeId}`);
      if (wiki.status === "failed") throw new Error(`wiki ingest failed: ${knowledgeId}`);
      if (wiki.status === "ready" || wiki.status === "draft") return;
      if (Date.now() > deadline) throw new Error(`wiki ingest timed out: ${knowledgeId}`);
      await delay(INGEST_POLL_INTERVAL_MS);
    }
  }

  // ───────────────────────── 待归类队列与人在回路（plan §5.4） ─────────────────────────

  listPending(): Array<{
    decisionId: string;
    sourceKind: string;
    sourceId: string;
    sourceVersion: number;
    title: string;
    summary: string | null;
    reason: string | null;
    confidence: number;
    decidedBy: string | null;
    newRoom: NewRoomProposal | null;
    candidates: Array<{ roomId: string; title: string; kind: string; entityScore?: number; vectorSimilarity?: number }>;
    createdAt: Date;
  }> {
    const rows = this.db.select().from(routeDecisions)
      .where(eq(routeDecisions.status, "awaiting_review"))
      .orderBy(desc(routeDecisions.createdAt))
      .limit(PENDING_PAGE_SIZE)
      .all();

    const roomIds = new Set<string>();
    for (const row of rows) {
      const evidence = (row.evidence ?? {}) as {
        entity?: Array<{ roomId: string; score?: number }>;
        vector?: Array<{ roomId: string; similarity?: number }>;
      };
      for (const entry of evidence.entity ?? []) roomIds.add(entry.roomId);
      for (const entry of evidence.vector ?? []) roomIds.add(entry.roomId);
    }
    const roomTitles = new Map<string, { title: string; kind: string }>();
    if (roomIds.size > 0) {
      const roomRows = this.db.select().from(rooms)
        .where(and(inArray(rooms.id, [...roomIds]), isNull(rooms.deletedAt))).all();
      for (const room of roomRows) roomTitles.set(room.id, { title: room.title, kind: room.kind });
    }

    return rows.map((row) => {
      const evidence = (row.evidence ?? {}) as {
        entity?: Array<{ roomId: string; score?: number }>;
        vector?: Array<{ roomId: string; similarity?: number }>;
        summary?: string;
      };
      const candidates = new Map<string, { roomId: string; title: string; kind: string; entityScore?: number; vectorSimilarity?: number }>();
      for (const entry of evidence.entity ?? []) {
        const room = roomTitles.get(entry.roomId);
        if (room && entry.score !== undefined) {
          candidates.set(entry.roomId, { roomId: entry.roomId, ...room, entityScore: entry.score });
        }
      }
      for (const entry of evidence.vector ?? []) {
        const room = roomTitles.get(entry.roomId);
        if (!room || entry.similarity === undefined) continue;
        const existing = candidates.get(entry.roomId);
        if (existing) existing.vectorSimilarity = entry.similarity;
        else candidates.set(entry.roomId, { roomId: entry.roomId, ...room, vectorSimilarity: entry.similarity });
      }
      const title = row.sourceKind === "everroom-doc"
        ? (this.db.select({ title: documents.title }).from(documents).where(eq(documents.id, row.sourceId)).get()?.title ?? row.sourceId)
        : (row.sourceTitle ?? row.sourceId);
      return {
        decisionId: row.id,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        sourceVersion: row.sourceVersion,
        title,
        summary: evidence.summary ?? null,
        reason: row.reason,
        confidence: row.confidence,
        decidedBy: row.decidedBy,
        newRoom: row.newRoomName
          ? { name: row.newRoomName, summary: row.newRoomSummary ?? "", ...(row.newRoomKind ? { kind: row.newRoomKind } : {}) }
          : null,
        candidates: [...candidates.values()],
        createdAt: row.createdAt,
      };
    });
  }

  /**
   * 最近已落定（confirmed）决策：撤销入口的数据源（plan §5.4 误归类纠正）。
   * 标题口径与 listPending 一致：everroom-doc 回查 documents，外部源取快照。
   */
  listRecentDecisions(limit = 20): Array<{
    decisionId: string;
    sourceKind: string;
    sourceId: string;
    title: string;
    roomId: string | null;
    roomTitle: string | null;
    decidedBy: string | null;
    confidence: number;
    reason: string | null;
    status: string;
    createdAt: Date;
  }> {
    const rows = this.db.select().from(routeDecisions)
      .where(eq(routeDecisions.status, "confirmed"))
      .orderBy(desc(routeDecisions.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100))
      .all();
    if (rows.length === 0) return [];

    const roomIds = [...new Set(rows.map((row) => row.primaryRoomId).filter((id): id is string => Boolean(id)))];
    const roomTitles = new Map<string, string>();
    if (roomIds.length > 0) {
      const roomRows = this.db.select({ id: rooms.id, title: rooms.title }).from(rooms)
        .where(inArray(rooms.id, roomIds)).all();
      for (const room of roomRows) roomTitles.set(room.id, room.title);
    }
    return rows.map((row) => ({
      decisionId: row.id,
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      title: row.sourceKind === "everroom-doc"
        ? (this.db.select({ title: documents.title }).from(documents).where(eq(documents.id, row.sourceId)).get()?.title ?? row.sourceId)
        : (row.sourceTitle ?? row.sourceId),
      roomId: row.primaryRoomId,
      roomTitle: row.primaryRoomId ? roomTitles.get(row.primaryRoomId) ?? null : null,
      decidedBy: row.decidedBy,
      confidence: row.confidence,
      reason: row.reason,
      status: row.status,
      createdAt: row.createdAt,
    }));
  }

  /**
   * 用户确认待归类决策（plan §5.4）：decidedBy=user，只作用当份文档，不生成规则。
   * createRoom 提议名先做重名去重（Dice ≥ 0.6 归并现有 Room，防碎片化）。
   */
  confirmDecision(
    decisionId: string,
    input: { roomIds?: string[]; createRoom?: { name: string; summary?: string; kind?: string } },
  ): { ok: true; roomId: string } | { ok: false; error: string } {
    const decision = this.db.select().from(routeDecisions).where(eq(routeDecisions.id, decisionId)).get();
    if (!decision) return { ok: false, error: "decision_not_found" };
    if (decision.status !== "awaiting_review") return { ok: false, error: "decision_not_awaiting_review" };

    let primaryRoomId: string;
    let linkedRoomIds: string[] = [];
    let reason: string;

    if (input.createRoom?.name) {
      const duplicate = this.router.findDuplicateRoom(input.createRoom.name);
      if (duplicate) {
        primaryRoomId = duplicate.id;
        reason = `用户确认新建，但「${input.createRoom.name}」与现有「${duplicate.title}」重名，已归并`;
      } else {
        primaryRoomId = `auto-${randomUUID().slice(0, 8)}`;
        this.db.insert(rooms).values({
          id: primaryRoomId,
          title: input.createRoom.name.trim().slice(0, 120),
          kind: input.createRoom.kind?.trim() || "主题",
          origin: "auto", // gateway 侧创建的 Room 统一 auto，渲染器认领后翻 user
          summary: input.createRoom.summary?.slice(0, 500) || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }).onConflictDoNothing().run();
        reason = "用户确认时新建 Room";
      }
    } else {
      const roomIds = [...new Set(input.roomIds ?? [])];
      if (roomIds.length === 0) return { ok: false, error: "room_ids_or_create_room_required" };
      const alive = this.db.select({ id: rooms.id }).from(rooms)
        .where(and(inArray(rooms.id, roomIds), isNull(rooms.deletedAt))).all();
      if (alive.length !== roomIds.length) return { ok: false, error: "room_not_found" };
      primaryRoomId = roomIds[0]!;
      linkedRoomIds = roomIds.slice(1);
      reason = "用户确认归属";
    }

    this.db.update(routeDecisions).set({
      primaryRoomId,
      linkedRoomIds: linkedRoomIds.length > 0 ? linkedRoomIds : null,
      decidedBy: "user",
      confidence: 1,
      reason,
      status: "auto",
      updatedAt: new Date(),
    }).where(eq(routeDecisions.id, decisionId)).run();

    this.insertJob(INGEST_JOB_TYPE, {
      sourceKind: decision.sourceKind,
      sourceId: decision.sourceId,
      sourceVersion: decision.sourceVersion,
      roomId: primaryRoomId,
      decisionId,
    });
    this.wake();
    return { ok: true, roomId: primaryRoomId };
  }

  /** 撤销已确认路由（plan §5.4）：清源 → 重路由（skipEntry，从 ② 起步）。 */
  async revertDecision(decisionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const decision = this.db.select().from(routeDecisions).where(eq(routeDecisions.id, decisionId)).get();
    if (!decision) return { ok: false, error: "decision_not_found" };
    if (decision.status !== "confirmed") return { ok: false, error: "decision_not_confirmed" };
    const evidence = (decision.evidence ?? {}) as { filename?: string; knowledgeId?: string };
    if (!decision.primaryRoomId || !evidence.filename) return { ok: false, error: "decision_has_no_ingest" };

    const knowledgeId = this.registry.resolveRoomWikiId(decision.primaryRoomId);
    if (knowledgeId) {
      await this.ks.rawRm(knowledgeId, [evidence.filename]);
      await this.ks.ingest(knowledgeId);
      await this.waitUntilSettled(knowledgeId);
      this.wikiIndex.invalidate(knowledgeId);
    }

    this.db.update(routeDecisions).set({ status: "reverted", updatedAt: new Date() })
      .where(eq(routeDecisions.id, decisionId)).run();

    // 重新路由：外部源靠决策行的 markdown 快照，everroom-doc 回查表
    const payload: RouteJobPayload = {
      sourceKind: decision.sourceKind,
      sourceId: decision.sourceId,
      sourceVersion: decision.sourceVersion,
      skipEntry: true,
      ...(decision.sourceMarkdown ? {
        envelope: {
          title: decision.sourceTitle ?? decision.sourceId,
          markdown: decision.sourceMarkdown,
        },
      } : {}),
    };
    this.insertJob(ROUTE_JOB_TYPE, payload);
    this.wake();
    return { ok: true };
  }

  // ───────────────────────── ②b 规则 CRUD（plan §3.1 逃生舱） ─────────────────────────

  listRules(): Array<{
    id: string;
    matcher: Record<string, unknown>;
    targetRoomId: string;
    enabled: boolean;
    hitCount: number;
    lastHitAt: Date | null;
    createdAt: Date;
  }> {
    return this.db.select().from(routingRules).orderBy(desc(routingRules.createdAt)).all().map((rule) => ({
      id: rule.id,
      matcher: (rule.matcher ?? {}) as Record<string, unknown>,
      targetRoomId: rule.targetRoomId,
      enabled: rule.enabled,
      hitCount: rule.hitCount,
      lastHitAt: rule.lastHitAt,
      createdAt: rule.createdAt,
    }));
  }

  createRule(input: {
    matcher: { sourceTag?: string; filenamePrefix?: string; threadId?: string; titleKeyword?: string; creatorId?: string };
    targetRoomId: string;
  }): { ok: true; id: string } | { ok: false; error: string } {
    const keys = Object.keys(input.matcher).filter((key) => {
      const value = (input.matcher as Record<string, string | undefined>)[key];
      return typeof value === "string" && value.trim().length > 0;
    });
    if (keys.length === 0) return { ok: false, error: "matcher_required" };
    const target = this.db.select({ id: rooms.id }).from(rooms)
      .where(and(eq(rooms.id, input.targetRoomId), isNull(rooms.deletedAt))).get();
    if (!target) return { ok: false, error: "target_room_not_found" };

    const id = randomUUID();
    const cleanMatcher: Record<string, string> = {};
    for (const key of keys) {
      cleanMatcher[key] = ((input.matcher as Record<string, string | undefined>)[key] ?? "").trim();
    }
    this.db.insert(routingRules).values({
      id,
      matcher: cleanMatcher,
      targetRoomId: input.targetRoomId,
      origin: "manual",
      enabled: true,
      createdAt: new Date(),
    }).run();
    return { ok: true, id };
  }

  deleteRule(id: string): boolean {
    const existing = this.db.select({ id: routingRules.id }).from(routingRules).where(eq(routingRules.id, id)).get();
    if (!existing) return false;
    this.db.delete(routingRules).where(eq(routingRules.id, id)).run();
    return true;
  }

  // ───────────────────────── Room 注册表（plan §3.1/§7.2） ─────────────────────────

  listRooms(origin?: "user" | "auto"): Array<{
    id: string;
    title: string;
    kind: string;
    origin: string;
    summary: string | null;
    aliases: string[];
    createdAt: Date;
    updatedAt: Date;
  }> {
    const conditions = [isNull(rooms.deletedAt)];
    if (origin) conditions.push(eq(rooms.origin, origin));
    return this.db.select().from(rooms)
      .where(and(...conditions))
      .orderBy(desc(rooms.updatedAt))
      .all()
      .map((row) => this.toRoomDto(row));
  }

  private toRoomDto(row: typeof rooms.$inferSelect): {
    id: string;
    title: string;
    kind: string;
    origin: string;
    summary: string | null;
    aliases: string[];
    createdAt: Date;
    updatedAt: Date;
  } {
    return {
      id: row.id,
      title: row.title,
      kind: row.kind,
      origin: row.origin,
      summary: row.summary,
      aliases: row.aliases ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * 渲染器上报 Room 的 upsert 语义（plan §7.2）：
   * 命中 origin=auto 行视为认领——翻转为 user，旧 title 记入 aliases。
   */
  upsertRoom(input: { id: string; title: string; kind?: string }): {
    id: string;
    title: string;
    kind: string;
    origin: string;
    summary: string | null;
    aliases: string[];
    createdAt: Date;
    updatedAt: Date;
  } {
    const now = new Date();
    const existing = this.db.select().from(rooms).where(eq(rooms.id, input.id)).get();
    if (!existing) {
      this.db.insert(rooms).values({
        id: input.id,
        title: input.title.trim().slice(0, 120),
        kind: input.kind?.trim() || "议题",
        origin: "user",
        createdAt: now,
        updatedAt: now,
      }).run();
    } else {
      const aliases = new Set(existing.aliases ?? []);
      if (existing.title !== input.title.trim()) aliases.add(existing.title);
      this.db.update(rooms).set({
        title: input.title.trim().slice(0, 120),
        ...(input.kind?.trim() ? { kind: input.kind.trim() } : {}),
        origin: "user",
        aliases: aliases.size > 0 ? [...aliases] : null,
        deletedAt: null,
        updatedAt: now,
      }).where(eq(rooms.id, input.id)).run();
    }
    const row = this.db.select().from(rooms).where(eq(rooms.id, input.id)).get();
    return this.toRoomDto(row!);
  }

  /** 软删除（默认策略：wiki 归档不删、documents/links 保留、候选池剔除）。 */
  deleteRoom(roomId: string): boolean {
    const existing = this.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).get();
    if (!existing) return false;
    this.db.update(rooms).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(rooms.id, roomId)).run();
    this.db.update(roomWikis).set({ status: "archived" })
      .where(eq(roomWikis.roomId, roomId)).run();
    return true;
  }

  /** Room 资料清单 = 派生视图（room_doc_links ⨝ documents，plan §3.2），不进 rooms 行。 */
  roomMaterials(roomId: string): Array<{
    documentId: string;
    title: string;
    version: number;
    updatedAt: Date;
    ingested: boolean;
  }> {
    const docs = this.db.select({ document: documents, linkedAt: roomDocumentLinks.linkedAt })
      .from(roomDocumentLinks)
      .innerJoin(documents, eq(roomDocumentLinks.documentId, documents.id))
      .where(eq(roomDocumentLinks.roomId, roomId))
      .orderBy(asc(roomDocumentLinks.linkedAt))
      .all();
    if (docs.length === 0) return [];
    const confirmed = this.db.select({ sourceId: routeDecisions.sourceId })
      .from(routeDecisions)
      .where(and(
        eq(routeDecisions.sourceKind, "everroom-doc"),
        eq(routeDecisions.primaryRoomId, roomId),
        eq(routeDecisions.status, "confirmed"),
      ))
      .all();
    const ingested = new Set(confirmed.map((row) => row.sourceId));
    return docs.map(({ document }) => ({
      documentId: document.id,
      title: document.title,
      version: document.version,
      updatedAt: document.updatedAt,
      ingested: ingested.has(document.id),
    }));
  }
}
