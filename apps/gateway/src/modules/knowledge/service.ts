import { randomUUID } from "node:crypto";
import type { DocumentEvent, RoomDocument } from "@nxcore/agent-contract";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { KnowledgeLlmConfig } from "../../config.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  documents,
  entities as entitiesTable,
  gatewayMetadata,
  ingestEvents,
  jobs,
  roomDocumentLinks,
  roomWikis,
  routeDecisions,
  routingRules,
  rooms,
  uploadedFiles,
} from "../../infrastructure/database/schema.js";
import { FilesService } from "../files/service.js";
import { fileIdOf } from "../files/storage.js";
import { EmbeddingClient } from "./embedding.js";
import {
  EntityRegistry,
  meetsPromotionThreshold,
  type EntityLinkRow,
  type EntityRow,
  type SourceKind,
} from "./entity-registry.js";
import { bestMatch } from "./entity-index.js";
import { buildDocumentEnvelope, envelopeFilename, type DocEnvelope } from "./envelope.js";
import { truncateUtf8 } from "../ingest/normalizers.js";
import { convertUploadedFile } from "./file-convert.js";
import { KnowledgeLlm, type RegisterResult } from "./llm.js";
import { KsAdminClient, KsBusyError, type KsWikiPageItem } from "./ks-client.js";
import { RoomWikiRegistry } from "./registry.js";
import { KnowledgeRouter } from "./router.js";

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
  /** 晋升证据分阈值（entity-room-plan §6，默认 2.0）。 */
  entityPromoteScore: number;
  /** 晋升最小资料数（防单份资料多角色刷分，默认 2）。 */
  entityPromoteSources: number;
  /** 弱-弱确定性自动合并线（默认 0.75，免 LLM）。 */
  mergeAutoDice: number;
  /** LLM 同一性判定带下限（默认 0.6）。 */
  mergeJudgeDice: number;
  /** 抽取/判定 LLM 端点；null = 无 LLM，全部落未识别栏。 */
  llm: KnowledgeLlmConfig | null;
  /** embedding 端点；null 或 embeddingModel 空 = 关闭（消歧回退证据分）。 */
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
const PROMOTE_JOB_TYPE = "knowledge.entity-promote";
/** ingest 完成轮询 / get 的间隔与总超时（plan §5.3 步骤 5）。 */
const INGEST_POLL_INTERVAL_MS = 2_000;
const INGEST_POLL_TIMEOUT_MS = 10 * 60_000;
/** 409 busy / 瞬时不可达的退避间隔与最大尝试次数。 */
const BUSY_RETRY_DELAY_MS = 5_000;
const MAX_TRANSIENT_ATTEMPTS = 5;
/** 未识别栏 / 候选实体列表单页上限。 */
const LIST_PAGE_SIZE = 100;
/** 晋升 backlog 的收敛轮次上限（防止持续新链接把晋升 job 变成长驻循环）。 */
const BACKLOG_MAX_PASSES = 3;

/** wiki 消费端 markdown 上限（unified-ingest-plan §7：截断在消费端，不在引擎）。 */
const WIKI_MAX_MARKDOWN_BYTES = 512 * 1024;

interface IngestJobPayload {
  sourceKind: SourceKind;
  sourceId: string;
  sourceVersion: number;
  roomId: string;
  decisionId: string;
}

interface RouteJobPayload {
  sourceKind: SourceKind;
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
  sourceKind: SourceKind;
  sourceId: string;
}

interface PromoteJobPayload {
  entityId: string;
  /** 手动转正（REST）：审计用，执行路径与自动晋升一致。 */
  manual?: boolean;
}

interface PendingSchedule {
  timer: NodeJS.Timeout;
  version: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * ingest 落盘账本（evidence.rooms）：多对多沉淀下同一资料会同时/先后
 * 进多个 Room wiki——路由命中多个已晋升实体、mention 实体后晋升的补账，
 * 都让资料出现在第二个 wiki。删除/撤销/补账去重必须按账本逐房判断，
 * 只认最新 primaryRoomId 会漏掉旧落点（导出供单测）。
 */
export function mergeIngestLedger(
  evidence: unknown,
  roomId: string,
  knowledgeId: string,
  filename: string,
): Record<string, unknown> {
  const base = (evidence ?? {}) as Record<string, unknown>;
  const rooms = Array.isArray(base.rooms)
    ? [...base.rooms as Array<Record<string, unknown>>]
    : [];
  const entry = { roomId, knowledgeId, filename };
  const index = rooms.findIndex((item) => item.roomId === roomId);
  if (index >= 0) rooms[index] = entry;
  else rooms.push(entry);
  return { ...base, filename, knowledgeId, rooms };
}

/**
 * 仅链接计分标记（unified-ingest-plan §6.3）：引擎台账快照 wiki=false 的
 * 源，路由/晋升照常建链接，但不沉淀正文。linkOnlyRooms 与 rooms 账本
 * 平行记录——不影响 ingestLedgerOf 的落点枚举（没有落盘就没有可清页面）。
 */
export function markLinkOnlyRoom(evidence: unknown, roomId: string): Record<string, unknown> {
  const base = (evidence ?? {}) as Record<string, unknown>;
  const list = Array.isArray(base.linkOnlyRooms)
    ? base.linkOnlyRooms.filter((item): item is string => typeof item === "string")
    : [];
  return { ...base, linkOnlyRooms: list.includes(roomId) ? list : [...list, roomId] };
}

/** 决策标记为仅链接计分的 Room 列表（markLinkOnlyRoom 的读取侧）。 */
export function linkOnlyRoomsOf(decision: { evidence: unknown }): string[] {
  const evidence = (decision.evidence ?? {}) as { linkOnlyRooms?: unknown };
  return Array.isArray(evidence.linkOnlyRooms)
    ? evidence.linkOnlyRooms.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * 台账快照判定（导出供单测）：源最近一次 ingest_events 的 wiki 开关。
 * 无台账行（旧入口）一律 false——既有沉淀行为不变。
 */
export function wikiDisabledForSource(
  db: GatewayDatabase,
  sourceKind: string,
  sourceId: string,
): boolean {
  const row = db.select({ pipelines: ingestEvents.pipelines })
    .from(ingestEvents)
    .where(and(
      eq(ingestEvents.sourceKind, sourceKind as typeof ingestEvents.sourceKind.enumValues[number]),
      eq(ingestEvents.sourceId, sourceId),
    ))
    .orderBy(desc(ingestEvents.createdAt), desc(ingestEvents.id))
    .limit(1)
    .get();
  return row?.pipelines?.wiki === false;
}

/** 决策历史上落过盘的全部 wiki 位点（账本优先，旧数据回退单点记录）。 */
export function ingestLedgerOf(decision: {
  evidence: unknown;
  primaryRoomId: string | null;
}): Array<{ roomId: string; filename: string }> {
  const evidence = (decision.evidence ?? {}) as { rooms?: unknown; filename?: unknown };
  if (Array.isArray(evidence.rooms)) {
    const entries = evidence.rooms
      .filter((item): item is { roomId: string; filename: string } =>
        typeof item === "object" && item !== null
        && typeof (item as { roomId?: unknown }).roomId === "string"
        && typeof (item as { filename?: unknown }).filename === "string")
      .map((item) => ({ roomId: item.roomId, filename: item.filename }));
    if (entries.length > 0) return entries;
  }
  if (decision.primaryRoomId && typeof evidence.filename === "string") {
    return [{ roomId: decision.primaryRoomId, filename: evidence.filename }];
  }
  return [];
}

// ───────────────────────── wiki 内链图谱（Karpathy LLM-wiki 式 link graph） ─────────────────────────

/** 图谱派生的单页读取上限（防大 wiki 把网关拖进长轮询）。 */
const WIKI_GRAPH_MAX_PAGES = 200;

/**
 * 解析 markdown 里的内链目标（去重）：`[[目标]]`/`[[目标|标签]]` 维基链与
 * `[标签](相对路径)` markdown 链。外链（http/mailto/锚点）不算内链。
 */
export function parseWikiLinks(markdown: string): string[] {
  const targets = new Set<string>();
  for (const match of markdown.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const target = match[1]!.trim();
    if (target) targets.add(target);
  }
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1]!.trim();
    if (!href || /^(https?:|mailto:|#|\/\/)/i.test(href)) continue;
    targets.add(href);
  }
  return [...targets];
}

/** 链接目标归一化：去锚点、去 ./ 与首尾 /、去 md 扩展名（比对用）。 */
function normalizeLinkTarget(target: string): string {
  let value = target.split("#")[0]!.trim();
  while (value.startsWith("./")) value = value.slice(2);
  return value.replace(/^\/+|\/+$/g, "").replace(/\.(md|markdown)$/i, "");
}

/** 内链目标 → 页面 id 的解析：精确 path > 标题 > path 末段（去扩展名）。 */
export function resolveWikiLinkTarget(target: string, pages: KsWikiPageItem[]): string | null {
  const normalized = normalizeLinkTarget(target);
  if (!normalized) return null;
  const byPath = pages.find((page) => normalizeLinkTarget(page.path) === normalized);
  if (byPath) return byPath.id;
  const byTitle = pages.find((page) => page.title.trim() === target.trim());
  if (byTitle) return byTitle.id;
  const byBasename = pages.find((page) => {
    const segments = normalizeLinkTarget(page.path).split("/");
    return segments[segments.length - 1] === normalized.split("/").pop();
  });
  return byBasename?.id ?? null;
}

/** 页面集合 + 各页 markdown → 链接图（节点=页面，边=内链；自环与重复合并）。 */
export function buildWikiGraph(
  pages: KsWikiPageItem[],
  contents: Map<string, string | null>,
): {
  nodes: Array<{ id: string; title: string; path: string; inLinks: number }>;
  edges: Array<{ source: string; target: string }>;
} {
  const edgeKeys = new Set<string>();
  const edges: Array<{ source: string; target: string }> = [];
  const inLinks = new Map<string, number>();
  for (const page of pages) {
    const content = contents.get(page.id);
    if (!content) continue;
    for (const target of parseWikiLinks(content)) {
      const resolved = resolveWikiLinkTarget(target, pages);
      if (!resolved || resolved === page.id) continue;
      const key = `${page.id}→${resolved}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ source: page.id, target: resolved });
      inLinks.set(resolved, (inLinks.get(resolved) ?? 0) + 1);
    }
  }
  edges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  return {
    nodes: pages.map((page) => ({
      id: page.id,
      title: page.title,
      path: page.path,
      inLinks: inLinks.get(page.id) ?? 0,
    })),
    edges,
  };
}

/**
 * Knowledge 路由与 ingest 编排（docs/entity-room-plan.md）。
 *
 * routerEnabled=false：M0 行为——① 入口直连（EverRoom 内文档天然带
 * roomId，confidence=1 直连 ingest）。
 * routerEnabled=true：commit → 防抖 → route job → ①/②b/③′③″④ →
 * execute（命中已晋升实体）派生 ingest job；linked 留弱实体孵化；
 * 达阈值实体翻 ready 进推荐池——建 Room 只经用户确认（promoteEntity）。
 *
 * worker 约束：ingest per-room 串行、promote per-entity 串行（KS /ingest
 * 并发 409），busy 退避重试；决策记 route_decisions 审计流水，
 * 归属事实源在 entity_doc_links。
 */
export class KnowledgeService {
  private readonly ks: KsAdminClient;
  private readonly registry: RoomWikiRegistry;
  private readonly entityRegistry: EntityRegistry;
  private readonly router: KnowledgeRouter;
  private readonly llm: KnowledgeLlm | null;
  /** 字节与登记表的唯一所有者是 modules/files（U9）；此处仅编排路由/ingest。 */
  private readonly files: FilesService;
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
    this.files = new FilesService(db, config.dataDir);
    this.ks = new KsAdminClient({
      baseUrl: config.baseUrl,
      serviceId: config.serviceId,
      teamId: config.teamId,
    });
    this.registry = new RoomWikiRegistry(this.db, this.ks);
    this.entityRegistry = new EntityRegistry(this.db);
    this.llm = config.llm ? new KnowledgeLlm(config.llm) : null;
    const embedding = config.embeddingLlm && config.embeddingModel
      ? { client: new EmbeddingClient(config.embeddingLlm, config.embeddingModel), model: config.embeddingModel }
      : null;
    this.router = new KnowledgeRouter({
      db,
      registry: this.entityRegistry,
      llm: this.llm,
      embedding,
      thresholds: {
        promoteScore: config.entityPromoteScore,
        promoteSources: config.entityPromoteSources,
        mergeAutoDice: config.mergeAutoDice,
        mergeJudgeDice: config.mergeJudgeDice,
      },
      logger: {
        info: (bindings, message) => this.logger.info(bindings, message),
        warn: (bindings, message) => this.logger.warn(bindings, message),
      },
    });
  }

  /** supervisor 生命周期钩子：崩溃恢复清扫 + 启动 worker 轮询。 */
  start(): void {
    // 存量 file 决策迁移到确定性身份（一次性，失败不阻塞启动）
    void this.backfillUploadedFiles().catch((error) => {
      this.logger.error(
        { event: "knowledge.files.backfill_failed", error: error instanceof Error ? error.message : String(error) },
        "uploaded files backfill failed",
      );
    });
    // 晋升崩溃恢复：promoting 滞留 → 回 weak（plan §4.4，重试由 job 重试兜底）
    const released = this.entityRegistry.releaseStuckPromotions();
    if (released > 0) {
      this.logger.warn(
        { event: "knowledge.entity.promoting_released", released },
        "stuck promoting entities reset to weak",
      );
    }
    // 推荐池补账：存量已达阈值的 weak 实体一次性翻 ready（旧自动晋升数据立即进推荐池）
    const backfillReady = this.entityRegistry.listEntities("weak")
      .filter((entity) => meetsPromotionThreshold(entity, {
        promoteScore: this.config.entityPromoteScore,
        promoteSources: this.config.entityPromoteSources,
      }));
    for (const entity of backfillReady) this.entityRegistry.markReady(entity.id);
    if (backfillReady.length > 0) {
      this.logger.info(
        { event: "knowledge.entity.ready_backfilled", count: backfillReady.length },
        "threshold-meeting weak entities moved to ready pool",
      );
    }
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

  /** Room wiki/路由 worker 是否启用。 */
  get enabled(): boolean {
    return this.config.roomWikisEnabled;
  }

  /**
   * 台账快照读取（unified-ingest-plan §6.3）：源经 /v1/ingest 进入时，
   * 取其最近一次 ingest_events 的策略快照——wiki=false 则路由/晋升只计
   * 链接分不沉淀正文。旧入口（无台账行）不受影响：维持既有沉淀行为。
   */
  private wikiDisabledForSource(sourceKind: string, sourceId: string): boolean {
    return wikiDisabledForSource(this.db, sourceKind, sourceId);
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
   * Room wiki 的内链图谱（页面=节点、md 内链=边）：逐页 readPage 后在网关侧
   * 派生。无 wiki / KS 不可达返回空图（图谱是增强视图，不阻塞浏览）。
   */
  async wikiGraph(roomId: string): Promise<{
    nodes: Array<{ id: string; title: string; path: string; inLinks: number }>;
    edges: Array<{ source: string; target: string }>;
  }> {
    const knowledgeId = this.registry.resolveRoomWikiId(roomId);
    if (!knowledgeId) return { nodes: [], edges: [] };
    try {
      const wiki = await this.ks.getWiki(knowledgeId);
      if (!wiki) return { nodes: [], edges: [] };
      const items = (await this.ks.listPages(knowledgeId)).slice(0, WIKI_GRAPH_MAX_PAGES);
      const contents = new Map<string, string | null>();
      for (const item of items) {
        try {
          const page = await this.ks.readPage(knowledgeId, item.path);
          contents.set(item.id, page && !page.not_found ? page.content ?? "" : null);
        } catch {
          contents.set(item.id, null); // 单页失败不拖垮整图
        }
      }
      return buildWikiGraph(items, contents);
    } catch (error) {
      this.logger.warn(
        { event: "knowledge.wiki.graph_failed", roomId, error: error instanceof Error ? error.message : String(error) },
        "wiki graph derivation failed, returning empty graph",
      );
      return { nodes: [], edges: [] };
    }
  }

  /**
   * Room 的上传文件清单（资料单一查询面，file 部分），双源并集后取每
   * file_id 最新一条：
   * a. primary_room_id = roomId 的决策——入口/规则/手动挂载/主 Room
   *    （分量最高晋升实体）回填的归属；
   * b. 房间实体链接派生——多对多沉淀下 mention 链接的文件同样落在
   *    本 Room，primary_room_id 只记主房，不看链接会漏。
   * 弱实体期（无已晋升链接）的文件不在任何 Room 名下。
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

    // b 源：房间户口实体的文件链接 → 各源最新决策（存在性并入，不覆盖 a 源）
    const room = this.db.select({ entityId: rooms.entityId }).from(rooms)
      .where(eq(rooms.id, roomId)).get();
    if (room?.entityId) {
      const linkSources = this.entityRegistry.linksOfEntity(room.entityId)
        .filter((link) => link.sourceKind === "file");
      const seen = new Set<string>();
      for (const link of linkSources) {
        if (seen.has(link.sourceId)) continue;
        seen.add(link.sourceId);
        const decision = this.db.select().from(routeDecisions)
          .where(and(
            eq(routeDecisions.sourceKind, "file"),
            eq(routeDecisions.sourceId, link.sourceId),
          ))
          .orderBy(desc(routeDecisions.createdAt))
          .get();
        // 覆盖写入：链接派生取的是该源真·最新决策（a 源按 primary_room_id
        // 过滤出的行可能早被重路由取代）
        if (decision) latestBySource.set(decision.sourceId, decision);
      }
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
    return this.files.markdownOf(fileId);
  }

  /** 文件本体的绝对路径（主进程 reveal 用）；无文件返回 null。 */
  fileStoragePath(fileId: string): string | null {
    return this.files.storagePathOf(fileId);
  }

  // ───────────────────────── 文档事件入口（① 层） ─────────────────────────

  /** documents 模块事件回调：committed/updated 触发防抖入队，deleted 触发清理。 */
  handleDocumentEvent(event: DocumentEvent): void {
    if (!this.config.roomWikisEnabled) return;
    switch (event.type) {
      case "document.changed": {
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

  /**
   * 统一 ingest 的文档扇出入口：实体 router 开启时提交完整信封；关闭时
   * 使用 documents -> room_doc_links 的权威归属，直接进入该 Room。
   */
  submitCommittedDocument(input: {
    documentId: string;
    sourceVersion: number;
    title: string;
    markdown: string;
    occurredAt?: string;
  }): { queued: boolean; jobId: string } {
    if (this.config.routerEnabled) {
      return this.submitEnvelope({
        sourceKind: "everroom-doc",
        sourceId: input.documentId,
        sourceVersion: input.sourceVersion,
        title: input.title,
        markdown: input.markdown,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      });
    }
    const target = this.getDocumentWithRoom(input.documentId);
    if (!target || target.document.version !== input.sourceVersion) {
      throw new Error(`committed document ${input.documentId}@${input.sourceVersion} has no current Room`);
    }
    return { queued: true, jobId: this.enqueueEntryIngest(target.document, target.roomId) };
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
      contentSchemaVersion: row.contentSchemaVersion,
      version: row.version,
      status: row.status,
      activeTransactionId: row.activeTransactionId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** 防抖到点 / 手动触发：按 router 开关走瀑布或 M0 直连。 */
  private enqueueFromDocument(documentId: string): string | null {
    const target = this.getDocumentWithRoom(documentId);
    if (!target) return null;
    if (this.config.routerEnabled) {
      const payload: RouteJobPayload = {
        sourceKind: "everroom-doc",
        sourceId: target.document.id,
        sourceVersion: target.document.version,
      };
      const jobId = this.insertJob(ROUTE_JOB_TYPE, payload);
      this.wake();
      return jobId;
    }
    return this.enqueueEntryIngest(target.document, target.roomId);
  }

  /** M0 路径（router 关闭）：① 入口决策 + ingest job 一步到位。 */
  private enqueueEntryIngest(document: RoomDocument, roomId: string): string {
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
    const jobId = this.insertJob(INGEST_JOB_TYPE, payload);
    this.wake();
    return jobId;
  }

  /** 外部信封入口（route/manual 全量信封）：router 必须开启。 */
  submitEnvelope(input: {
    sourceKind: SourceKind;
    title: string;
    markdown: string;
    occurredAt?: string;
    entrySignals?: DocEnvelope["entrySignals"];
    sourceId?: string;
    sourceVersion?: number;
  }): { queued: boolean; jobId: string } {
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
    const jobId = this.insertJob(ROUTE_JOB_TYPE, payload);
    this.wake();
    return { queued: true, jobId };
  }

  /**
   * 上传文件入口（用户主路径：拖个文件进来 → 抽取实体 → 弱实体累积）。
   * 四道判重闸门的前两道在此：闸1 同名同内容 → 全跳过（零成本）；
   * 同名新内容 → 版本更新（同 sourceId，重新抽取解析——链接跟随实体走，
   * plan §4.6，不再"永久锁死第一个 Room"）。
   */
  async submitFileUpload(input: {
    filename: string;
    buffer: Buffer;
    occurredAt?: string;
    entrySignals?: DocEnvelope["entrySignals"];
  }): Promise<{ queued: boolean; sourceId: string; title: string; deduped: boolean }> {
    const converted = convertUploadedFile(input.filename, input.buffer);
    const sourceId = fileIdOf(input.filename);

    // 资产段经 modules/files（U9）：闸1 同名同内容 → 全跳过；同名新内容 →
    // 版本更新（身份不变）。存储完成后这里只做解析回填与路由入队。
    const uploaded = await this.files.upload({ filename: input.filename, buffer: input.buffer });
    if (uploaded.deduped) {
      // 闸1：同名且内容未变——不存、不解析、不入队（链接与归属必然没变）
      this.logger.info(
        { event: "knowledge.file.deduped", sourceId, filename: input.filename },
        "file re-upload with unchanged content skipped",
      );
      return { queued: false, sourceId, title: uploaded.originalName, deduped: true };
    }
    const parsedId = this.files.ensureParsed(uploaded.contentHash, converted.markdown);
    this.files.touchParsed(sourceId, parsedId);

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
      uploaded.versionUpdated ? "file version updated for routing" : "file uploaded for routing",
    );
    return { queued: true, sourceId, title: converted.title, deduped: false };
  }

  /** file 的下一个版本号：取该源已有决策的最大 source_version + 1。 */
  nextFileVersion(sourceId: string): number {
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
   * 让既有资料进入新身份体系（重传即可被闸 1 认出）。
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
      const registered = await this.files.registerBackfillFile({
        originalName,
        markdown: snapshot.markdown,
      });
      if (!registered) {
        this.logger.warn(
          { event: "knowledge.files.backfill_blob_failed", legacyId },
          "backfill blob write failed, row skipped",
        );
        continue;
      }
      this.db.update(routeDecisions)
        .set({ sourceId: registered.fileId, updatedAt: new Date() })
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

  /**
   * 文件删除级联入口（modules/files 调用）：Room/wiki 侧清理——按落盘
   * 账本逐房 raw/rm + 决策回退（与 document.deleted 同款异步 job）。
   */
  requestFileCleanup(sourceId: string): void {
    this.enqueueCleanup("file", sourceId);
  }

  /** 文档永久删除后的可靠清理入口，由持久化 document outbox 调用。 */
  requestDocumentCleanup(documentId: string): void {
    this.enqueueCleanup("everroom-doc", documentId);
  }

  private enqueueCleanup(sourceKind: SourceKind, sourceId: string): void {
    const payload: CleanupJobPayload = { sourceKind, sourceId };
    this.insertJob(CLEANUP_JOB_TYPE, payload);
    this.wake();
  }

  private insertJob(
    type: string,
    payload: IngestJobPayload | RouteJobPayload | CleanupJobPayload | PromoteJobPayload,
  ): string {
    const id = randomUUID();
    this.db.insert(jobs).values({ id, type, status: "pending", payload }).run();
    this.logger.info({ event: "knowledge.job.enqueued", jobId: id, type }, `knowledge job enqueued: ${type}`);
    return id;
  }

  private wake(): void {
    void this.drain();
  }

  // ───────────────────────── worker（plan §5.3 + §4.4 晋升） ─────────────────────────

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const candidates = this.db.select().from(jobs)
        .where(and(
          eq(jobs.status, "pending"),
          inArray(jobs.type, [INGEST_JOB_TYPE, ROUTE_JOB_TYPE, CLEANUP_JOB_TYPE, PROMOTE_JOB_TYPE]),
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

  /**
   * 串行锁键：ingest 用 roomId（wiki 1:1 Room）、promote 用 entity:
   * （晋升与增量 ingest 都写同一 wiki）；route/cleanup 无锁。
   */
  private lockKeyOf(job: typeof jobs.$inferSelect): string | null {
    if (job.type === INGEST_JOB_TYPE) {
      return (job.payload as IngestJobPayload).roomId;
    }
    if (job.type === PROMOTE_JOB_TYPE) {
      return `entity:${(job.payload as PromoteJobPayload).entityId}`;
    }
    return null;
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
      } else if (job.type === PROMOTE_JOB_TYPE) {
        await this.runPromotionJob(job.payload as PromoteJobPayload);
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

  /** route job：重建信封 → 瀑布 → execute 派生 ingest、达阈值派生 promote。 */
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
    if (result.disposition === "execute" && result.roomIds.length > 0) {
      // 多对多沉淀：每个已晋升链接实体的 Room 各入队一个 ingest job
      // （lockKeyOf 按 roomId 加锁，各 wiki 独立串行，互不阻塞）
      for (const roomId of result.roomIds) {
        this.insertJob(INGEST_JOB_TYPE, {
          sourceKind: envelope.ref.kind,
          sourceId: envelope.ref.id,
          sourceVersion: envelope.ref.version,
          roomId,
          decisionId: result.decisionId,
        });
      }
    }
    this.logger.info(
      {
        event: "knowledge.route.decided",
        sourceId: envelope.ref.id,
        disposition: result.disposition,
        decidedBy: result.decidedBy,
        roomId: result.roomId,
        roomIds: result.roomIds,
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

    // 台账快照过滤（§6.3）：经引擎进入且 wiki=false 的源只计链接分，
    // 不沉淀正文（快照而非实时 policy——事后改策略不漂移已进入的资料）
    if (this.wikiDisabledForSource(payload.sourceKind, payload.sourceId)) {
      this.db.update(routeDecisions).set({
        status: "confirmed",
        evidence: markLinkOnlyRoom(decision.evidence, payload.roomId),
        updatedAt: new Date(),
      }).where(eq(routeDecisions.id, payload.decisionId)).run();
      this.logger.info(
        { event: "knowledge.ingest.link_only", sourceId: payload.sourceId, roomId: payload.roomId },
        "source wiki-disabled at ingest: link-only, no deposition",
      );
      return;
    }

    const knowledgeId = await this.registry.ensureWikiForRoom(payload.roomId);
    const filename = envelopeFilename(envelope);

    await this.ks.rawWrite(knowledgeId, [{ filename, content: envelope.markdown }]);
    await this.ks.ingest(knowledgeId);
    await this.waitUntilSettled(knowledgeId);

    this.db.update(routeDecisions).set({
      status: "confirmed",
      // 合并写入（不覆写路由审计：summary/entities 保留；rooms 为落盘账本）
      evidence: mergeIngestLedger(decision.evidence, payload.roomId, knowledgeId, filename),
      updatedAt: new Date(),
    }).where(eq(routeDecisions.id, payload.decisionId)).run();

    this.logger.info(
      { event: "knowledge.ingest.confirmed", sourceId: payload.sourceId, roomId: payload.roomId, knowledgeId },
      "document ingested into room wiki",
    );
  }

  // ───────────────────────── 晋升 job（entity-room-plan §4.4） ─────────────────────────

  /**
   * 弱实体 → Room 的全流程：同名扫描 → 转正登记 → rooms 插行 →
   * ensureWiki → 批量 ingest（全部链接的资料，不分角色，每源最新版本）。
   *
   * 幂等性：room 行已建（roomId 回填）时直接走 backlog 补账——重复入队、
   * 部分失败重试、晋升中途新链接的资料都收敛到同一条补账路径。
   */
  private async runPromotionJob(payload: PromoteJobPayload): Promise<void> {
    const entity = this.entityRegistry.getEntity(payload.entityId);
    if (!entity || entity.status === "archived") return;

    if (entity.roomId) {
      // 已建 Room（含重试续跑/重复入队/种子实体）：只补未沉淀的 backlog
      await this.ingestEntityBacklog(entity.id);
      return;
    }
    if (entity.status !== "weak" && entity.status !== "ready" && entity.status !== "promoting") return;
    if (!this.entityRegistry.claimForPromotion(entity.id)) return; // 并行晋升在处理：静默退出

    // 步骤 2：同名扫描——撞已晋升实体（Dice ≥ judge 线）→ LLM 同一性判定
    const collision = await this.scanPromotedCollision(entity);
    if (collision.outcome === "hold") {
      // 判定失败：回 weak 等重试（保守取向，不硬并也不硬立）
      this.entityRegistry.releasePromotion(entity.id);
      throw new Error(`promotion identity judge failed for entity ${entity.id}`);
    }
    if (collision.target) {
      // 判定同一：弱实体整体并入既有实体，不建新 Room（验收 4：同名不重建）
      this.entityRegistry.mergeEntities({
        intoId: collision.target.id,
        fromId: entity.id,
        reason: collision.reason,
      });
      await this.ingestEntityBacklog(collision.target.id);
      this.logger.info(
        { event: "knowledge.entity.merged_on_promote", fromId: entity.id, intoId: collision.target.id, reason: collision.reason },
        "weak entity merged into existing promoted entity",
      );
      return;
    }

    // 步骤 3：转正登记（LLM 一次；失败用现有 name + 首条依据拼底稿）
    const registration = await this.registerEntityOrFallback(entity);

    // 步骤 4：rooms 插行 + status=room + roomId 回填——先于链接查询（竞态防护：
    // 晋升中途到达的链接，其资料经 backlog 补账不会被漏掉）
    const roomId = `auto-${randomUUID().slice(0, 8)}`;
    this.db.insert(rooms).values({
      id: roomId,
      title: registration.name,
      kind: entity.kind,
      origin: "auto",
      summary: registration.summary || null,
      aliases: registration.aliases.length > 0 ? registration.aliases : null,
      entityId: entity.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing().run();
    this.entityRegistry.promoteToRoom(entity.id, roomId);

    // 步骤 6：批量 ingest（步骤 5 的 ensureWiki 在 backlog 内做）
    await this.ingestEntityBacklog(entity.id);
    this.logger.info(
      { event: "knowledge.entity.promoted", entityId: entity.id, roomId, name: registration.name, manual: payload.manual ?? false },
      "weak entity promoted to room",
    );
  }

  /**
   * 晋升前同名扫描（plan §4.4 步骤 2）：与全部已晋升实体比对
   * name+aliases，Dice ≥ judge 线 → LLM 同一性判定。
   * 判定失败 → hold（调用方回 weak 重试）；不同 → 正常晋升。
   */
  private async scanPromotedCollision(
    entity: EntityRow,
  ): Promise<{ outcome: "promote" | "merge" | "hold"; target: EntityRow | null; reason: string }> {
    const promoted = this.entityRegistry.listEntities("room");
    let target: EntityRow | null = null;
    let bestScore = 0;
    for (const candidate of promoted) {
      if (candidate.id === entity.id) continue;
      const match = bestMatch(entity.name, [candidate.name, ...candidate.aliases]);
      if (match && match.score > bestScore) {
        target = candidate;
        bestScore = match.score;
      }
    }
    if (!target || bestScore < this.config.mergeJudgeDice) {
      return { outcome: "promote", target: null, reason: `同名扫描无碰撞（best=${bestScore.toFixed(2)}）` };
    }

    if (!this.llm) {
      // 无 LLM 无法判定：保守放行晋升（分立无害，E3 可手动合并）
      return { outcome: "promote", target: null, reason: "无 LLM，同名碰撞按分立处理" };
    }
    try {
      const judge = await this.llm.judgeEntityIdentity(
        {
          name: entity.name,
          aliases: entity.aliases,
          kind: entity.kind,
          evidenceSamples: this.evidenceSamplesOf(entity.id),
        },
        {
          name: target.name,
          aliases: target.aliases,
          kind: target.kind,
          evidenceSamples: this.evidenceSamplesOf(target.id),
        },
      );
      if (judge.same) return { outcome: "merge", target, reason: judge.reason };
      return { outcome: "promote", target: null, reason: judge.reason };
    } catch (error) {
      this.logger.warn(
        {
          event: "knowledge.entity.promote_judge_failed",
          entityId: entity.id,
          targetId: target.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "promotion identity judge failed, holding promotion",
      );
      return { outcome: "hold", target: null, reason: "" };
    }
  }

  /** 实体的依据句样本（≤5，登记与判定的输入）。 */
  private evidenceSamplesOf(entityId: string): string[] {
    return this.entityRegistry.linksOfEntity(entityId)
      .map((link) => link.evidence)
      .filter((evidence): evidence is string => Boolean(evidence))
      .slice(0, 5);
  }

  /** 转正登记（plan §4.4 步骤 3）：LLM 失败降级现有 name + 首条依据。 */
  private async registerEntityOrFallback(entity: EntityRow): Promise<RegisterResult> {
    const links = this.entityRegistry.linksOfEntity(entity.id);
    const evidenceLines = links
      .map((link) => link.evidence)
      .filter((evidence): evidence is string => Boolean(evidence))
      .slice(0, 30);
    const docSummaries = this.docSummariesOf(links);

    if (this.llm) {
      try {
        const registration = await this.llm.registerEntity({
          name: entity.name,
          kind: entity.kind,
          evidenceLines,
          docSummaries,
        });
        this.entityRegistry.updateEntityIdentity(entity.id, {
          name: registration.name,
          summary: registration.summary || null,
          addAliases: registration.aliases,
        });
        return registration;
      } catch (error) {
        this.logger.warn(
          {
            event: "knowledge.entity.register_failed",
            entityId: entity.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "entity registration LLM failed, using fallback identity",
        );
      }
    }
    const fallback: RegisterResult = {
      name: entity.name,
      summary: evidenceLines[0] ?? `${entity.kind}（证据分 ${entity.evidenceScore.toFixed(1)}）`,
      aliases: [],
    };
    this.entityRegistry.updateEntityIdentity(entity.id, { summary: fallback.summary });
    return fallback;
  }

  /** 实体关联资料的摘要（每源最新决策的 evidence.summary / 快照头部）。 */
  private docSummariesOf(links: EntityLinkRow[]): string[] {
    const summaries: string[] = [];
    const seen = new Set<string>();
    for (const link of links) {
      const key = `${link.sourceKind}:${link.sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const decision = this.db.select().from(routeDecisions)
        .where(and(
          eq(routeDecisions.sourceKind, link.sourceKind),
          eq(routeDecisions.sourceId, link.sourceId),
        ))
        .orderBy(desc(routeDecisions.createdAt))
        .get();
      if (!decision) continue;
      const evidence = (decision.evidence ?? {}) as { summary?: string };
      summaries.push(
        evidence.summary
        ?? (decision.sourceMarkdown ? this.markdownHead(decision.sourceMarkdown) : decision.sourceTitle ?? "")
        ?? decision.sourceId,
      );
    }
    return summaries.slice(0, 10);
  }

  private markdownHead(markdown: string): string {
    return markdown.replace(/[#>*`|\[\]()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  }

  /**
   * 批量补账：把实体全部链接（不分角色——mention 链接的实体晋升后
   * 同样收正文）的资料（每源最新版本）落进实体 Room 的 wiki。收敛循环
   * 兜住晋升/合并中途到达的新链接；账本已含 {roomId, filename} 者跳过
   * （幂等，重复入队零副作用，其他 Room 的确认不挡本房补账）。
   */
  private async ingestEntityBacklog(entityId: string): Promise<void> {
    const entity = this.entityRegistry.getEntity(entityId);
    if (!entity?.roomId) return;
    const roomId = entity.roomId;
    // 懒 ensure：全部链接源都被台账快照判为仅链接计分时不建空 wiki
    let knowledgeId: string | null = null;

    for (let pass = 0; pass < BACKLOG_MAX_PASSES; pass += 1) {
      const links = this.entityRegistry.linksOfEntity(entityId);
      const latestBySource = new Map<string, EntityLinkRow>();
      for (const link of links) {
        const key = `${link.sourceKind}:${link.sourceId}`;
        const existing = latestBySource.get(key);
        if (!existing || link.sourceVersion > existing.sourceVersion) latestBySource.set(key, link);
      }

      let ingested = 0;
      for (const link of latestBySource.values()) {
        const decision = this.db.select().from(routeDecisions)
          .where(and(
            eq(routeDecisions.sourceKind, link.sourceKind),
            eq(routeDecisions.sourceId, link.sourceId),
          ))
          .orderBy(desc(routeDecisions.createdAt))
          .get();
        if (!decision) continue; // 无决策行（信封已丢）：跳过，链接仍在

        // 台账快照过滤（§6.3）：wiki=false 的源晋升补账也只计链接分
        if (this.wikiDisabledForSource(link.sourceKind, link.sourceId)) {
          if (!ingestLedgerOf(decision).some((entry) => entry.roomId === roomId)
            && !linkOnlyRoomsOf(decision).includes(roomId)) {
            this.db.update(routeDecisions).set({
              evidence: markLinkOnlyRoom(decision.evidence, roomId),
              updatedAt: new Date(),
            }).where(eq(routeDecisions.id, decision.id)).run();
          }
          continue;
        }

        const envelope = await this.buildExecutionEnvelope(
          {
            sourceKind: link.sourceKind,
            sourceId: link.sourceId,
            sourceVersion: link.sourceVersion,
            roomId,
            decisionId: decision.id,
          },
          decision,
        );
        if (!envelope) continue;
        const filename = envelopeFilename(envelope);
        // 账本制跳过：本房本文件已沉淀过才跳——多对多下其他 Room 的
        // 确认（primaryRoomId 指向别房）不是跳过理由
        if (ingestLedgerOf(decision).some((entry) => entry.roomId === roomId && entry.filename === filename)) continue;

        knowledgeId ??= await this.registry.ensureWikiForRoom(roomId);
        await this.ks.rawWrite(knowledgeId, [{ filename, content: envelope.markdown }]);
        await this.ks.ingest(knowledgeId);
        await this.waitUntilSettled(knowledgeId);

        this.db.update(routeDecisions).set({
          // 仅空时回填：主 Room（分量最高晋升实体）指针不被后补账覆盖
          primaryRoomId: decision.primaryRoomId ?? roomId,
          status: "confirmed",
          evidence: mergeIngestLedger(decision.evidence, roomId, knowledgeId, filename),
          updatedAt: new Date(),
        }).where(eq(routeDecisions.id, decision.id)).run();
        ingested += 1;
      }
      if (ingested === 0) return; // 收敛：本轮无新沉淀
    }
    this.logger.warn(
      { event: "knowledge.entity.backlog_unstable", entityId },
      `entity backlog did not converge within ${BACKLOG_MAX_PASSES} passes`,
    );
  }

  /** 执行时还原信封：everroom-doc 回查 documents（版本校验），外部源取决策快照。 */
  private async buildExecutionEnvelope(
    payload: IngestJobPayload,
    decision: typeof routeDecisions.$inferSelect,
  ): Promise<DocEnvelope | null> {
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
      // frontmatter 的 room 写执行目标（路由/晋升可能指向非源 Room）
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
      // 消费端截断（§7）：全文住 parsed_contents/决策快照，送 KS 前按 512KB 截
      // （everroom-doc 路径已在 buildDocumentEnvelope 内截）
      markdown: truncateUtf8(
        decision.sourceMarkdown,
        WIKI_MAX_MARKDOWN_BYTES,
        "<!-- 截断：原文超 wiki 512KB 上限，全文见文件中心 -->",
      ),
    };
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

    // 按落盘账本逐房清理：多对多沉淀下一份资料会进多个 wiki（路由命中
    // 多个已晋升实体 + mention 实体后晋升的补账），只看最新 primaryRoomId 会漏
    const handledWikis = new Set<string>();
    for (const decision of decisions) {
      for (const entry of ingestLedgerOf(decision)) {
        const key = `${entry.roomId}:${entry.filename}`;
        if (handledWikis.has(key)) continue;
        handledWikis.add(key);
        const knowledgeId = this.registry.resolveRoomWikiId(entry.roomId);
        if (!knowledgeId) continue;
        await this.ks.rawRm(knowledgeId, [entry.filename]);
        await this.ks.ingest(knowledgeId);
        await this.waitUntilSettled(knowledgeId);
      }
    }
    this.db.update(routeDecisions).set({ status: "reverted", updatedAt: new Date() })
      .where(and(
        eq(routeDecisions.sourceKind, payload.sourceKind),
        eq(routeDecisions.sourceId, payload.sourceId),
        eq(routeDecisions.status, "confirmed"),
      ))
      .run();
    this.logger.info(
      { event: "knowledge.cleanup.done", sourceId: payload.sourceId, wikis: [...handledWikis] },
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

  // ───────────────────────── 候选实体与未识别栏（entity-room-plan §4.7/§7） ─────────────────────────

  /** 候选实体列表（默认 weak；ready = 推荐池，首页"推荐 Room"数据源）。 */
  listCandidateEntities(status: "weak" | "ready" | "promoting" | "room" | "archived" = "weak"): Array<{
    id: string;
    name: string;
    kind: string;
    status: string;
    roomId: string | null;
    evidenceScore: number;
    sourceCount: number;
    promoteScore: number;
    promoteSources: number;
    firstEvidence: string | null;
    lastLinkedAt: Date | null;
    updatedAt: Date;
  }> {
    return this.entityRegistry.listEntities(status)
      .slice(0, LIST_PAGE_SIZE)
      .map((entity) => ({
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        status: entity.status,
        roomId: entity.roomId,
        evidenceScore: entity.evidenceScore,
        sourceCount: entity.sourceCount,
        promoteScore: this.config.entityPromoteScore,
        promoteSources: this.config.entityPromoteSources,
        firstEvidence: this.evidenceSamplesOf(entity.id)[0] ?? null,
        lastLinkedAt: entity.lastLinkedAt,
        updatedAt: entity.updatedAt,
      }));
  }

  /** 实体详情：链接资料 + 依据句 + 归属 Room（可解释性，验收 6）。 */
  getEntityDetail(entityId: string): {
    ok: true;
    entity: EntityRow;
    room: { id: string; title: string; kind: string } | null;
    links: Array<EntityLinkRow & { sourceTitle: string | null }>;
  } | { ok: false; error: string } {
    const entity = this.entityRegistry.getEntity(entityId);
    if (!entity) return { ok: false, error: "entity_not_found" };
    let room: { id: string; title: string; kind: string } | null = null;
    if (entity.roomId) {
      const row = this.db.select().from(rooms).where(eq(rooms.id, entity.roomId)).get();
      if (row && !row.deletedAt) room = { id: row.id, title: row.title, kind: row.kind };
    }
    const links = this.entityRegistry.linksOfEntity(entity.id).map((link) => ({
      ...link,
      sourceTitle: this.sourceTitleOf(link),
    }));
    return { ok: true, entity, room, links };
  }

  private sourceTitleOf(link: EntityLinkRow): string | null {
    if (link.sourceKind === "everroom-doc") {
      return this.db.select({ title: documents.title }).from(documents)
        .where(eq(documents.id, link.sourceId)).get()?.title ?? null;
    }
    if (link.sourceKind === "file") {
      return this.db.select({ name: uploadedFiles.originalName }).from(uploadedFiles)
        .where(eq(uploadedFiles.id, link.sourceId)).get()?.name ?? null;
    }
    return this.db.select({ title: routeDecisions.sourceTitle }).from(routeDecisions)
      .where(and(
        eq(routeDecisions.sourceKind, link.sourceKind),
        eq(routeDecisions.sourceId, link.sourceId),
      ))
      .orderBy(desc(routeDecisions.createdAt))
      .get()?.title ?? null;
  }

  /**
   * 用户确认创建（推荐确认制的唯一建 Room 入口）：ready/weak 实体走完整
   * 晋升流程（含同名扫描与 LLM 转正登记）。用户出手即是明确信号——
   * 不设阈值门槛（ED8 修订：建 Room 收回用户确认权）。
   */
  promoteEntity(entityId: string): { ok: true } | { ok: false; error: string } {
    const entity = this.entityRegistry.getEntity(entityId);
    if (!entity) return { ok: false, error: "entity_not_found" };
    if (entity.status !== "weak" && entity.status !== "ready") {
      return { ok: false, error: "entity_not_promotable" };
    }
    this.insertJob(PROMOTE_JOB_TYPE, { entityId, manual: true });
    this.wake();
    return { ok: true };
  }

  /**
   * 手动合并（plan §4.5 用户主动治理）：from 并入 into；已晋升侧的 wiki
   * 级联（from Room 的源文件清理 + 目标 re-ingest）走 backlog 补账。
   */
  async mergeEntity(fromId: string, intoId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const from = this.entityRegistry.getEntity(fromId);
    const into = this.entityRegistry.getEntity(intoId);
    if (!from || !into) return { ok: false, error: "entity_not_found" };
    if (from.id === into.id) return { ok: false, error: "cannot_merge_into_self" };

    // Room 级合并：from 的 Room 软删 + wiki 归档（渲染器同步收起），
    // 目标 Room 的内容经 backlog 重建（from 的源迁过去重新沉淀）。
    if (from.roomId && from.roomId !== into.roomId) {
      await this.retireRoomWiki(from.roomId, `实体合并：${from.name} → ${into.name}`);
    }

    this.entityRegistry.mergeEntities({ intoId: into.id, fromId: from.id, reason: "用户手动合并" });
    await this.ingestEntityBacklog(into.id);
    return { ok: true };
  }

  /** Room 软删 + wiki 归档（合并/删除共用；KS 数据保留，可整卷恢复）。 */
  private async retireRoomWiki(roomId: string, reason: string): Promise<void> {
    this.db.update(rooms).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(rooms.id, roomId)).run();
    this.db.update(roomWikis).set({ status: "archived" })
      .where(eq(roomWikis.roomId, roomId)).run();
    this.logger.info(
      { event: "knowledge.room.retired", roomId, reason },
      "room retired (soft-deleted, wiki archived)",
    );
  }

  /**
   * 未识别资料手动挂实体（plan §4.7）：role=manual（+1.5 证据分）。
   * 实体已晋升 → 直接派生 ingest；达阈值 → 翻 ready 进推荐池。
   */
  attachDoc(input: {
    sourceKind: SourceKind;
    sourceId: string;
    entityId?: string;
    createEntity?: { name: string; kind: string };
  }): { ok: true; entityId: string } | { ok: false; error: string } {
    if (!input.entityId && !input.createEntity?.name) {
      return { ok: false, error: "entity_id_or_create_entity_required" };
    }
    const decision = this.db.select().from(routeDecisions)
      .where(and(
        eq(routeDecisions.sourceKind, input.sourceKind),
        eq(routeDecisions.sourceId, input.sourceId),
      ))
      .orderBy(desc(routeDecisions.createdAt))
      .get();
    if (!decision) return { ok: false, error: "source_not_routed" };

    let entity: EntityRow | null;
    if (input.entityId) {
      entity = this.entityRegistry.getEntity(input.entityId);
      if (!entity) return { ok: false, error: "entity_not_found" };
    } else {
      entity = this.entityRegistry.createEntity({
        name: input.createEntity!.name,
        kind: input.createEntity!.kind,
      });
    }

    const updated = this.entityRegistry.upsertLink({
      entityId: entity.id,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourceVersion: decision.sourceVersion,
      role: "manual",
      salience: 1,
      evidence: "用户手动挂载",
      decidedBy: "user",
    });

    // 决策流水补记归属（挂到已晋升实体时立即可 ingest）
    if (updated.status === "room" && updated.roomId) {
      this.db.update(routeDecisions).set({
        primaryRoomId: updated.roomId,
        decidedBy: "user",
        confidence: 1,
        reason: `手动挂载到已晋升实体「${updated.name}」`,
        status: "auto",
        updatedAt: new Date(),
      }).where(eq(routeDecisions.id, decision.id)).run();
      this.insertJob(INGEST_JOB_TYPE, {
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        sourceVersion: decision.sourceVersion,
        roomId: updated.roomId,
        decisionId: decision.id,
      });
    } else {
      this.db.update(routeDecisions).set({
        decidedBy: "user",
        reason: `手动挂载到弱实体「${updated.name}」（证据累积中）`,
        updatedAt: new Date(),
      }).where(eq(routeDecisions.id, decision.id)).run();
      // 推荐确认制：达阈值只进推荐池，等用户确认创建
      if (meetsPromotionThreshold(updated, {
        promoteScore: this.config.entityPromoteScore,
        promoteSources: this.config.entityPromoteSources,
      })) {
        this.entityRegistry.markReady(updated.id);
      }
    }
    this.wake();
    return { ok: true, entityId: entity.id };
  }

  /** 未识别栏（plan §7）：抽取空/失败的资料，等待人工挂载。 */
  listUnmatched(): Array<{
    decisionId: string;
    sourceKind: string;
    sourceId: string;
    title: string;
    summary: string | null;
    reason: string | null;
    createdAt: Date;
  }> {
    const rows = this.db.select().from(routeDecisions)
      .where(eq(routeDecisions.status, "awaiting_review"))
      .orderBy(desc(routeDecisions.createdAt))
      .limit(LIST_PAGE_SIZE)
      .all();
    return rows.map((row) => {
      const evidence = (row.evidence ?? {}) as { summary?: string };
      const title = row.sourceKind === "everroom-doc"
        ? (this.db.select({ title: documents.title }).from(documents).where(eq(documents.id, row.sourceId)).get()?.title ?? row.sourceId)
        : (row.sourceTitle ?? row.sourceId);
      return {
        decisionId: row.id,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        title,
        summary: evidence.summary ?? null,
        reason: row.reason,
        createdAt: row.createdAt,
      };
    });
  }

  /**
   * 最近已落定（confirmed）决策：撤销入口的数据源（plan §5.4 误归类纠正）。
   * 标题口径与 listUnmatched 一致：everroom-doc 回查 documents，外部源取快照。
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
   * 撤销已确认路由（plan §5.4）：按落盘账本逐房清源 → 重路由
   * （skipEntry，从 ② 起步）。
   */
  async revertDecision(decisionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const decision = this.db.select().from(routeDecisions).where(eq(routeDecisions.id, decisionId)).get();
    if (!decision) return { ok: false, error: "decision_not_found" };
    if (decision.status !== "confirmed") return { ok: false, error: "decision_not_confirmed" };
    const ledger = ingestLedgerOf(decision);
    if (ledger.length === 0) return { ok: false, error: "decision_has_no_ingest" };

    // 账本里可能有多个落点 wiki（晋升补账迁移归属）：全部清一遍再各触发一次 ingest
    const settledWikis = new Set<string>();
    for (const entry of ledger) {
      const knowledgeId = this.registry.resolveRoomWikiId(entry.roomId);
      if (!knowledgeId) continue;
      await this.ks.rawRm(knowledgeId, [entry.filename]);
      if (settledWikis.has(knowledgeId)) continue;
      settledWikis.add(knowledgeId);
      await this.ks.ingest(knowledgeId);
      await this.waitUntilSettled(knowledgeId);
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
   * 命中 origin=auto 行视为认领——翻转为 user，旧 title 记入 aliases；
   * ED4：无户口实体的 Room 顺手种子化（已晋升态，evidence 视为已满足）。
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
    // 户口实体同步：新建种子化；改名同步到实体（旧名进 aliases）
    const entity = this.entityRegistry.seedRoomEntity({
      id: row!.id,
      title: row!.title,
      kind: row!.kind,
      aliases: row!.aliases ?? [],
    });
    if (entity && entity.name !== row!.title) {
      this.entityRegistry.updateEntityIdentity(entity.id, {
        name: row!.title,
        addAliases: row!.aliases ?? [],
      });
    }
    return this.toRoomDto(row!);
  }

  /** 软删除（默认策略：wiki 归档不删、documents/links 保留、候选池剔除）。 */
  deleteRoom(roomId: string): boolean {
    const existing = this.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).get();
    if (!existing) return false;
    void this.retireRoomWiki(roomId, "渲染器上报删除");
    this.db.update(entitiesTable).set({ status: "archived", updatedAt: new Date() })
      .where(eq(entitiesTable.roomId, roomId)).run();
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
    const confirmed = this.db.select({
      sourceId: routeDecisions.sourceId,
      primaryRoomId: routeDecisions.primaryRoomId,
      evidence: routeDecisions.evidence,
    })
      .from(routeDecisions)
      .where(and(
        eq(routeDecisions.sourceKind, "everroom-doc"),
        eq(routeDecisions.status, "confirmed"),
      ))
      .all();
    const ingested = new Set<string>();
    for (const row of confirmed) {
      // 多对多沉淀：主房指针或落盘账本任一命中本房即算已沉淀
      if (row.primaryRoomId === roomId
        || ingestLedgerOf(row).some((entry) => entry.roomId === roomId)) {
        ingested.add(row.sourceId);
      }
    }
    return docs.map(({ document }) => ({
      documentId: document.id,
      title: document.title,
      version: document.version,
      updatedAt: document.updatedAt,
      ingested: ingested.has(document.id),
    }));
  }
}
