import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DocumentEvent, RoomDocument, TiptapJsonContent } from "@nxcore/agent-contract";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { KnowledgeLlmConfig } from "../../config.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  documents,
  entities as entitiesTable,
  gatewayMetadata,
  ingestEvents,
  jobs,
  roomDocumentLinks,
  roomEntityMentions,
  roomSourceMemberships,
  roomWikis,
  routeDecisions,
  routingRules,
  rooms,
  uploadedFiles,
} from "../../infrastructure/database/schema.js";
import { FilesService } from "../files/service.js";
import { fileIdOf } from "../files/storage.js";
import { cosineSimilarity, decodeCentroid, EmbeddingClient } from "./embedding.js";
import {
  EntityRegistry,
  type EntityLinkRow,
  type EntityRow,
  type SourceKind,
} from "./entity-registry.js";
import { bestMatch } from "./entity-index.js";
import { buildDocumentEnvelope, envelopeFilename, type DocEnvelope } from "./envelope.js";
import { truncateUtf8 } from "../ingest/normalizers.js";
import { convertUploadedFile } from "./file-convert.js";
import {
  KnowledgeLlm,
  type RegisterResult,
  type RoomContextResult,
} from "./llm.js";
import { tiptapToMarkdown } from "./tiptap-markdown.js";
import { OpenAiCompletionAgentRuntime } from "../agent/openai-completion-runtime.js";
import { AgentResolver, BUILTIN_AGENT_IDS } from "../agent/resolver.js";
import { loadBuiltinAgentBundle } from "../agent/builtin-bundles.js";
import { bundledAgentDefinitionsDir } from "../../config.js";
import { KsAdminClient, KsBusyError, type KsWikiPageItem } from "./ks-client.js";
import { RoomWikiRegistry } from "./registry.js";
import { KnowledgeRouter } from "./router.js";
import {
  ROOM_RELATION_INDEX_JOB_TYPE,
  RoomRelationRegistry,
  type RelationIndexInput,
  type RoomGraphDto,
  type RoomRelationDto,
  type RoomRelationManualType,
  type RoomRelationVisibility,
} from "./room-relations.js";

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
  /** V2 标准路径证据分阈值（默认 2.4）。 */
  entityPromoteScore: number;
  /** V2 标准路径最小有效证据组数（默认 3）。 */
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
  /** Minimum automatic Room relation score (default 1.0). */
  roomRelationMinScore?: number;
}

export interface KnowledgeServiceLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

function createKnowledgeAgentResolver(dataDir: string, llm: KnowledgeLlmConfig): AgentResolver {
  const resolver = new AgentResolver();
  const id = BUILTIN_AGENT_IDS.knowledge;
  const bundle = loadBuiltinAgentBundle(bundledAgentDefinitionsDir(), id);
  const root = join(dataDir, "agent", "runtimes", id);
  const configDirectory = join(root, "config");
  resolver.register({ id, name: bundle.name, description: bundle.description, configDirectory, kind: "builtin" }, () => (
    new OpenAiCompletionAgentRuntime({
      runtimeId: id,
      ...llm,
      systemPrompt: bundle.systemPrompt,
      skillPrompts: bundle.skillPrompts,
      temperature: 0.1,
      maxTokens: 4_096,
      timeoutMs: 60_000,
      sessionsDir: join(root, "sessions"),
      workingDirectory: join(root, "workspace"),
      agentDirectory: configDirectory,
    })
  ));
  return resolver;
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
  entryRoomId?: string;
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
  /** 用户已在中置信重复提示中明确选择继续新建。 */
  forceNew?: boolean;
  previousStatus?: "weak" | "ready";
}

export interface ExistingRoomMatch {
  roomId: string;
  roomTitle: string;
  entityId: string;
  confidence: "high" | "medium";
  score: number;
  reasons: string[];
}

interface RelationIndexJobPayload {
  sourceKind: SourceKind;
  sourceId: string;
  sourceVersion: number;
  roomIds: string[];
}

export type PromotionStage =
  | "queued"
  | "checking_identity"
  | "registering_entity"
  | "creating_room"
  | "creating_wiki"
  | "importing_documents"
  | "completed"
  | "failed";

interface PromotionJobResult {
  stage: PromotionStage;
  message: string;
  current?: number;
  total?: number;
  roomId?: string;
}

export interface PromotionProgress {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  stage: PromotionStage;
  message: string;
  current: number | null;
  total: number | null;
  queuePosition: number | null;
  roomId: string | null;
  error: string | null;
  updatedAt: Date;
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
  private readonly relationRegistry: RoomRelationRegistry;
  private readonly router: KnowledgeRouter;
  private llm: KnowledgeLlm | null;
  private readonly externalAgentResolver: AgentResolver | null;
  private readonly roomContextCache = new Map<string, { key: string; value: RoomContextSummary }>();
  private ownedAgentResolver: AgentResolver | null;
  /** 字节与登记表的唯一所有者是 modules/files（U9）；此处仅编排路由/ingest。 */
  private readonly files: FilesService;
  private readonly pendingSchedules = new Map<string, PendingSchedule>();
  private readonly busyRoomKeys = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private readonly transientAttempts = new Map<string, number>();
  private drainTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private drainRequested = false;
  private promotionDraining = false;
  private promotionDrainRequested = false;
  private roomDuplicateIndexTrigger: (() => void) | null = null;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly config: KnowledgeServiceConfig,
    private readonly logger: KnowledgeServiceLogger,
    agentResolver?: AgentResolver,
  ) {
    this.files = new FilesService(db, config.dataDir);
    this.ks = new KsAdminClient({
      baseUrl: config.baseUrl,
      serviceId: config.serviceId,
      teamId: config.teamId,
    });
    this.registry = new RoomWikiRegistry(this.db, this.ks);
    this.entityRegistry = new EntityRegistry(this.db, {
      promoteScore: config.entityPromoteScore,
      promoteSources: config.entityPromoteSources,
    });
    this.relationRegistry = new RoomRelationRegistry(this.db, config.roomRelationMinScore ?? 1);
    this.ownedAgentResolver = config.llm && !agentResolver
      ? createKnowledgeAgentResolver(config.dataDir, config.llm)
      : null;
    this.llm = config.llm ? new KnowledgeLlm(agentResolver ?? this.ownedAgentResolver!) : null;
    this.externalAgentResolver = agentResolver ?? null;
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

  /** runtime config 变更后替换消歧 tie-break 的 embedding 端点（null = 关闭）。 */
  replaceEmbedding(embedding: { client: EmbeddingClient; model: string } | null): void {
    this.router.replaceEmbedding(embedding);
  }

  setRoomDuplicateIndexTrigger(trigger: () => void): void {
    this.roomDuplicateIndexTrigger = trigger;
  }

  /**
   * runtime config 变更后替换抽取/判定 LLM（null = 关闭）。boot 时 env 未配
   * NXCORE_KNOWLEDGE_LLM_*、SaaS/用户配置稍后到达的场景由此补上；llm 到位
   * 同时按需自建 ownedAgentResolver（主进程注入的 resolver 缺 knowledge
   * agent 时 registerAgent 兜底在 create-server onChange 里做）。
   */
  replaceLlm(llm: KnowledgeLlmConfig | null): void {
    if (!llm) return;
    if (!this.llm && !this.ownedAgentResolver && !this.externalAgentResolver) {
      this.ownedAgentResolver = createKnowledgeAgentResolver(this.config.dataDir, llm);
    }
    this.llm = new KnowledgeLlm(this.externalAgentResolver ?? this.ownedAgentResolver!);
    this.router.replaceLlm(this.llm);
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
    // 崩溃/热重载恢复：运行中的本地任务没有外部 worker 接管，必须重新排队。
    const recoveredJobs = this.db.update(jobs).set({ status: "pending", updatedAt: new Date() })
      .where(and(
        eq(jobs.status, "running"),
        inArray(jobs.type, [INGEST_JOB_TYPE, ROUTE_JOB_TYPE, CLEANUP_JOB_TYPE, PROMOTE_JOB_TYPE, ROOM_RELATION_INDEX_JOB_TYPE]),
      )).run() as { changes: number | bigint };
    if (Number(recoveredJobs.changes) > 0) {
      this.logger.warn(
        { event: "knowledge.jobs.recovered", count: Number(recoveredJobs.changes) },
        "stuck running knowledge jobs moved back to pending",
      );
    }
    const deduplicatedJobs = this.deduplicatePendingJobs();
    if (deduplicatedJobs > 0) {
      this.logger.warn(
        { event: "knowledge.jobs.deduplicated", count: deduplicatedJobs },
        "duplicate pending knowledge jobs cancelled",
      );
    }
    // 旧版本允许重复点击产生多条晋升任务。恢复时每个实体只保留最早一条，
    // 其余任务作为同一意图的重复提交取消，避免重启后重复执行 backlog。
    const deduplicatedPromotions = this.deduplicatePendingPromotions();
    if (deduplicatedPromotions > 0) {
      this.logger.warn(
        { event: "knowledge.promotion_jobs.deduplicated", count: deduplicatedPromotions },
        "duplicate entity promotion jobs cancelled",
      );
    }
    // 晋升崩溃恢复：promoting 滞留 → 回 weak；下方阈值补账会恢复 ready。
    const released = this.entityRegistry.releaseStuckPromotions();
    if (released > 0) {
      this.logger.warn(
        { event: "knowledge.entity.promoting_released", released },
        "stuck promoting entities reset to weak",
      );
    }
    // V2 可重入回算：补评分快照、邮件线程聚合，并同步 weak/ready 双向状态。
    const rescored = this.entityRegistry.rescoreAll();
    if (rescored.links > 0 || rescored.entities > 0) {
      this.logger.info(
        { event: "knowledge.entity.v2_rescored", ...rescored },
        "knowledge evidence rescored with V2 rules",
      );
    }
    const relationBackfill = this.relationRegistry.rebuildFromFacts();
    const pendingRelationDocuments = this.relationRegistry.pendingDocumentIndexes();
    if (pendingRelationDocuments.length > 0) {
      this.relationRegistry.markIndexing(this.llm ? "building" : "degraded");
      if (this.llm) {
        for (const pending of pendingRelationDocuments) {
          this.insertJob(ROOM_RELATION_INDEX_JOB_TYPE, {
            sourceKind: "everroom-doc",
            sourceId: pending.sourceId,
            sourceVersion: pending.sourceVersion,
            roomIds: pending.roomIds,
          });
        }
      }
    }
    // 事实记忆存量回填：老来源补抽 facts（PRD CR-014：Room 记忆 = 实体 + 事实）。
    // 一次性：完成后记标记；无 LLM 时不标记，等配置后下次启动再补。
    const pendingFactSources = this.relationRegistry.pendingFactBackfill();
    if (pendingFactSources.length > 0) {
      if (this.llm) {
        this.relationRegistry.markIndexing("building");
        for (const source of pendingFactSources) {
          this.insertJob(ROOM_RELATION_INDEX_JOB_TYPE, {
            sourceKind: source.sourceKind,
            sourceId: source.sourceId,
            sourceVersion: source.sourceVersion,
            roomIds: source.roomIds,
          });
        }
        this.relationRegistry.markFactBackfillCompleted();
        this.logger.info(
          { event: "knowledge.room_facts.backfill_enqueued", sources: pendingFactSources.length },
          "fact memory backfill enqueued for indexed sources",
        );
      }
    }
    this.logger.info(
      { event: "knowledge.room_relations.backfilled", ...relationBackfill },
      "Room relation projections rebuilt from durable facts",
    );
    if (this.drainTimer || !this.config.roomWikisEnabled) return;
    this.drainTimer = setInterval(() => this.wake(), 1_000);
    this.drainTimer.unref();
    this.wake();
  }

  dispose(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
    void this.ownedAgentResolver?.dispose();
    for (const schedule of this.pendingSchedules.values()) clearTimeout(schedule.timer);
    this.pendingSchedules.clear();
  }

  /** Room 当前 wiki 解析（会话级挂载用，plan §6.1）。 */
  resolveRoomWikiId(roomId: string): string | null {
    return this.registry.resolveRoomWikiId(this.canonicalRoomId(roomId));
  }

  private canonicalRoomId(roomId: string): string {
    let current = roomId.trim();
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const row = this.db.select({ lifecycle: rooms.lifecycle, mergedIntoRoomId: rooms.mergedIntoRoomId })
        .from(rooms).where(eq(rooms.id, current)).get();
      if (!row || row.lifecycle === "active") return current;
      if (row.lifecycle !== "merged" || !row.mergedIntoRoomId) return current;
      current = row.mergedIntoRoomId;
    }
    return roomId.trim();
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

  /** Room duplicate service reuses the existing identity judge; it never auto-merges Rooms. */
  async judgeRoomIdentity(
    a: { name: string; aliases: string[]; kind: string; evidenceSamples: string[] },
    b: { name: string; aliases: string[]; kind: string; evidenceSamples: string[] },
  ): Promise<{ same: boolean; reason: string }> {
    if (!this.llm) throw new Error("knowledge_identity_judge_unavailable");
    return this.llm.judgeEntityIdentity(a, b);
  }

  /** Page count is used only by the user-facing merge impact preview. */
  async roomWikiFileCount(roomId: string): Promise<number> {
    const pages = await this.listRoomWikiPages(roomId);
    return pages.pageCount ?? pages.items.length;
  }

  /**
   * Finalize the Knowledge projection after the local ownership transaction.
   * The source wiki is retired and every target document is queued for a fresh,
   * authoritative target-wiki ingest. No reverse snapshot is retained.
   */
  async mergeRoomKnowledge(sourceRoomId: string, targetRoomId: string): Promise<void> {
    const source = this.db.select().from(rooms).where(eq(rooms.id, sourceRoomId)).get();
    const target = this.db.select().from(rooms).where(eq(rooms.id, targetRoomId)).get();
    if (source?.entityId && target?.entityId && source.entityId !== target.entityId) {
      this.entityRegistry.mergeEntities({
        intoId: target.entityId,
        fromId: source.entityId,
        reason: "user_confirmed_room_merge",
      });
      this.relationRegistry.rewriteEntity(source.entityId, target.entityId);
    } else if (source?.entityId && target && !target.entityId) {
      this.db.update(rooms).set({ entityId: source.entityId, updatedAt: new Date() })
        .where(eq(rooms.id, targetRoomId)).run();
      this.db.update(entitiesTable).set({ roomId: targetRoomId, updatedAt: new Date() })
        .where(eq(entitiesTable.id, source.entityId)).run();
    }

    this.db.update(roomWikis).set({ status: "archived" })
      .where(eq(roomWikis.roomId, sourceRoomId)).run();
    if (this.config.roomWikisEnabled) {
      const documentIds = this.db.select({ id: roomDocumentLinks.documentId }).from(roomDocumentLinks)
        .where(eq(roomDocumentLinks.roomId, targetRoomId)).all().map((item) => item.id);
      for (const documentId of documentIds) this.routeDocumentNow(documentId);
    }
    this.relationRegistry.rebuildFromFacts();
    this.roomContextCache.delete(sourceRoomId);
    this.roomContextCache.delete(targetRoomId);
  }

  rebuildRoomRelations(): void {
    this.relationRegistry.rebuildFromFacts();
  }

  // ───────────────────────── Wiki 页面读取（渲染器 Wiki Tab 数据源） ─────────────────────────

  /**
   * Room wiki 页面清单 + 处理状态（processing 徽标，plan §10 竞态对策）。
   * Room 尚无 wiki（懒创建未触发）返回 status="none"，Tab 显示"尚无沉淀"。
   */
  async listRoomWikiPages(roomId: string): Promise<{ status: string; items: KsWikiPageItem[]; pageCount: number | null }> {
    const knowledgeId = this.resolveRoomWikiId(roomId);
    if (!knowledgeId) return { status: "none", items: [], pageCount: null };
    const wiki = await this.ks.getWiki(knowledgeId);
    if (!wiki) return { status: "none", items: [], pageCount: null };
    const items = await this.ks.listPages(knowledgeId);
    // page_count：KS 内部已产出页数（processing 期间 ls 为空，用它透出构建进度）
    return { status: wiki.status, items, pageCount: wiki.page_count };
  }

  /** 读单页 Markdown 全文（ref = page/ls 的 path）；无 wiki 或页面缺失返回 null。 */
  async readRoomWikiPage(roomId: string, ref: string): Promise<string | null> {
    const knowledgeId = this.resolveRoomWikiId(roomId);
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
    const knowledgeId = this.resolveRoomWikiId(roomId);
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
    roomId = this.canonicalRoomId(roomId);
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
    // 回收站文档视同不存在：软删除后不再进入路由/抽取（恢复时 lifecycle 会
    // 重发 document.changed 重新入队），避免已删文档被重新投影。
    const row = this.db.select({ document: documents, roomId: roomDocumentLinks.roomId })
      .from(documents)
      .innerJoin(roomDocumentLinks, eq(roomDocumentLinks.documentId, documents.id))
      .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
      .orderBy(asc(roomDocumentLinks.linkedAt))
      .get();
    if (!row) return null;
    return { document: this.toRoomDocument(row.document, row.roomId), roomId: row.roomId };
  }

  private getDocument(documentId: string): RoomDocument | null {
    // 同上：回收站文档对抽取管线不可见（job 兜底抽取/信封还原都会据此跳过）。
    const row = this.db.select().from(documents)
      .where(and(eq(documents.id, documentId), isNull(documents.deletedAt))).get();
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
    entryRoomId?: string;
  }): { queued: boolean; jobId: string } {
    const payload: RouteJobPayload = {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId ?? `ext-${randomUUID().slice(0, 12)}`,
      sourceVersion: input.sourceVersion ?? 1,
      ...(input.entryRoomId ? { entryRoomId: input.entryRoomId } : {}),
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
    this.requestSourceCleanup("file", sourceId);
  }

  /** 任意统一 ingest 来源的 Room/wiki 清理入口。 */
  requestSourceCleanup(sourceKind: SourceKind, sourceId: string): void {
    this.enqueueCleanup(sourceKind, sourceId);
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
    payload: IngestJobPayload | RouteJobPayload | CleanupJobPayload | PromoteJobPayload | RelationIndexJobPayload,
    result?: Record<string, unknown>,
  ): string {
    if (type !== PROMOTE_JOB_TYPE) {
      const serializedPayload = JSON.stringify(payload);
      const existing = this.db.select({ id: jobs.id, payload: jobs.payload }).from(jobs)
        .where(and(eq(jobs.type, type), inArray(jobs.status, ["pending", "running"])))
        .orderBy(asc(jobs.createdAt))
        .all()
        .find((job) => JSON.stringify(job.payload) === serializedPayload);
      if (existing) {
        this.logger.info(
          { event: "knowledge.job.reused", jobId: existing.id, type },
          `knowledge job already active: ${type}`,
        );
        return existing.id;
      }
    }
    const id = randomUUID();
    this.db.insert(jobs).values({ id, type, status: "pending", payload, ...(result ? { result } : {}) }).run();
    this.logger.info({ event: "knowledge.job.enqueued", jobId: id, type }, `knowledge job enqueued: ${type}`);
    return id;
  }

  private wake(): void {
    this.drainRequested = true;
    this.promotionDrainRequested = true;
    void this.drain();
    void this.drainPromotions();
  }

  // ───────────────────────── worker（plan §5.3 + §4.4 晋升） ─────────────────────────

  private async drain(): Promise<void> {
    if (this.draining) {
      this.drainRequested = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainRequested = false;
        for (;;) {
          const candidate = this.nextRunnableJob();
          if (!candidate) break;
          await this.processJob(candidate.job, candidate.lockKey);
        }
      } while (this.drainRequested);
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
   * 每完成一项后重新取队，使新产生的 Room 资料任务可以优先于历史连接器
   * route backlog 执行，而不是沿用 worker 启动时的一次性队列快照。
   */
  private nextRunnableJob(): { job: typeof jobs.$inferSelect; lockKey: string | null } | null {
    const candidates = this.db.select().from(jobs)
      .where(and(
        eq(jobs.status, "pending"),
        inArray(jobs.type, [INGEST_JOB_TYPE, ROUTE_JOB_TYPE, CLEANUP_JOB_TYPE, ROOM_RELATION_INDEX_JOB_TYPE]),
      ))
      // Room 的资料沉淀和清理先于连接器批量路由，缩短新 Room 可用时间。
      .orderBy(
        sql`case when ${jobs.type} = ${INGEST_JOB_TYPE} then 0 when ${jobs.type} = ${CLEANUP_JOB_TYPE} then 1 when ${jobs.type} = ${ROOM_RELATION_INDEX_JOB_TYPE} then 2 else 3 end`,
        asc(jobs.createdAt),
      )
      .limit(100)
      .all();
    const now = Date.now();
    for (const job of candidates) {
      const retryAt = this.retryAfter.get(job.id);
      if (retryAt && retryAt > now) continue;
      const lockKey = this.lockKeyOf(job);
      if (lockKey && this.busyRoomKeys.has(lockKey)) continue;
      return { job, lockKey };
    }
    return null;
  }

  /**
   * 用户触发的 Room 创建使用独立 worker。知识服务处理某个大 Wiki 时，
   * 创建任务仍可完成实体登记和 Room 落库，不被 route/ingest 的网络等待阻塞。
   */
  private async drainPromotions(): Promise<void> {
    if (this.promotionDraining) {
      this.promotionDrainRequested = true;
      return;
    }
    this.promotionDraining = true;
    try {
      do {
        this.promotionDrainRequested = false;
        for (;;) {
          const candidate = this.nextRunnablePromotion();
          if (!candidate) break;
          await this.processJob(candidate.job, candidate.lockKey);
        }
      } while (this.promotionDrainRequested);
    } catch (error) {
      this.logger.error(
        { event: "knowledge.promotion_worker.error", error: error instanceof Error ? error.message : String(error) },
        "knowledge promotion worker drain failed",
      );
    } finally {
      this.promotionDraining = false;
    }
  }

  private nextRunnablePromotion(): { job: typeof jobs.$inferSelect; lockKey: string | null } | null {
    const candidates = this.db.select().from(jobs)
      .where(and(eq(jobs.status, "pending"), eq(jobs.type, PROMOTE_JOB_TYPE)))
      .orderBy(asc(jobs.createdAt))
      .limit(100)
      .all();
    const now = Date.now();
    for (const job of candidates) {
      const retryAt = this.retryAfter.get(job.id);
      if (retryAt && retryAt > now) continue;
      const lockKey = this.lockKeyOf(job);
      if (lockKey && this.busyRoomKeys.has(lockKey)) continue;
      return { job, lockKey };
    }
    return null;
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
    this.db.update(jobs).set({
      status: "running",
      ...(job.type === PROMOTE_JOB_TYPE ? {
        result: { stage: "checking_identity", message: "正在确认实体身份", current: 1, total: 5 },
      } : {}),
      updatedAt: new Date(),
    })
      .where(eq(jobs.id, job.id)).run();
    try {
      if (job.type === INGEST_JOB_TYPE) {
        await this.runIngestJob(job.payload as IngestJobPayload);
      } else if (job.type === ROUTE_JOB_TYPE) {
        await this.runRouteJob(job.payload as RouteJobPayload);
      } else if (job.type === ROOM_RELATION_INDEX_JOB_TYPE) {
        await this.runRelationIndexJob(job.payload as RelationIndexJobPayload);
      } else if (job.type === PROMOTE_JOB_TYPE) {
        await this.runPromotionJob(job.id, job.payload as PromoteJobPayload);
      } else {
        await this.runCleanupJob(job.payload as CleanupJobPayload);
      }
      this.db.update(jobs).set({
        status: "completed",
        ...(job.type === PROMOTE_JOB_TYPE ? {
          result: {
            ...((this.db.select({ result: jobs.result }).from(jobs).where(eq(jobs.id, job.id)).get()?.result ?? {}) as Record<string, unknown>),
            stage: "completed",
            message: "Room 已创建，关联资料将在后台继续导入",
          },
        } : {}),
        updatedAt: new Date(),
      }).where(eq(jobs.id, job.id)).run();
      this.retryAfter.delete(job.id);
      this.transientAttempts.delete(job.id);
      this.roomDuplicateIndexTrigger?.();
    } catch (error) {
      if (error instanceof KsBusyError) {
        // 409 busy：回 pending 退避重试（per-wiki 串行约束的来源）。
        this.db.update(jobs).set({ status: "pending", updatedAt: new Date() }).where(eq(jobs.id, job.id)).run();
        if (job.type === PROMOTE_JOB_TYPE) {
          this.setPromotionProgress(job.id, "queued", "知识服务正忙，稍后继续");
        }
        this.retryAfter.set(job.id, Date.now() + BUSY_RETRY_DELAY_MS);
      } else {
        const attempts = (this.transientAttempts.get(job.id) ?? 0) + 1;
        const message = error instanceof Error ? error.message : String(error);
        // 速率限制（429/1302）是账户级瞬态：退避拉长（30s 起步，按次翻倍，
        // 上限 5 分钟），避免限速窗口内反复撞墙烧尝试次数。
        const rateLimited = KnowledgeLlm.isRateLimited(error);
        const maxAttempts = rateLimited ? MAX_TRANSIENT_ATTEMPTS * 4 : MAX_TRANSIENT_ATTEMPTS;
        const backoffMs = rateLimited
          ? Math.min(30_000 * 2 ** (attempts - 1), 300_000)
          : BUSY_RETRY_DELAY_MS * attempts;
        if (attempts < maxAttempts) {
          this.db.update(jobs).set({ status: "pending", updatedAt: new Date() }).where(eq(jobs.id, job.id)).run();
          this.retryAfter.set(job.id, Date.now() + backoffMs);
          this.transientAttempts.set(job.id, attempts);
          if (job.type === PROMOTE_JOB_TYPE) {
            this.setPromotionProgress(job.id, "queued", `暂时失败，准备第 ${String(attempts + 1)} 次尝试`);
          }
          this.logger.warn(
            { event: "knowledge.job.retry", jobId: job.id, attempts, backoffMs, rateLimited, error: message },
            "knowledge job failed, scheduled retry",
          );
        } else {
          this.db.update(jobs).set({
            status: "failed",
            error: { message },
            updatedAt: new Date(),
          }).where(eq(jobs.id, job.id)).run();
          this.transientAttempts.delete(job.id);
          if (job.type === PROMOTE_JOB_TYPE) {
            const payload = job.payload as PromoteJobPayload;
            this.setPromotionProgress(job.id, "failed", message);
            this.entityRegistry.releasePromotion(payload.entityId, payload.previousStatus ?? "ready");
          }
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

    const result = await this.router.route(envelope, {
      skipEntry: payload.skipEntry ?? false,
      ...(payload.entryRoomId ? { entryRoomId: payload.entryRoomId } : {}),
    });
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
      this.insertJob(ROOM_RELATION_INDEX_JOB_TYPE, {
        sourceKind: envelope.ref.kind,
        sourceId: envelope.ref.id,
        sourceVersion: envelope.ref.version,
        roomIds: result.roomIds,
      });
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

  /** Relation projection is asynchronous and never changes routing or recommendation state. */
  private async runRelationIndexJob(payload: RelationIndexJobPayload): Promise<void> {
    // 回收站文档直接跳过：积压 job 里可能还排着删除前入队的投影任务，
    // 放行会把已删文档的投影行重新写回（读侧剔除只是展示层兜底）。
    if (payload.sourceKind === "everroom-doc" && !this.getDocument(payload.sourceId)) return;
    const activeRoomIds = this.db.select({ id: rooms.id }).from(rooms)
      .where(and(inArray(rooms.id, payload.roomIds), isNull(rooms.deletedAt))).all().map((room) => room.id);
    if (activeRoomIds.length === 0) {
      this.relationRegistry.removeSource(payload.sourceKind, payload.sourceId);
      return;
    }
    const decision = this.db.select().from(routeDecisions).where(and(
      eq(routeDecisions.sourceKind, payload.sourceKind),
      eq(routeDecisions.sourceId, payload.sourceId),
      eq(routeDecisions.sourceVersion, payload.sourceVersion),
    )).orderBy(desc(routeDecisions.createdAt)).get();
    const evidence = (decision?.evidence ?? {}) as {
      entities?: Array<{ entityId?: unknown; role?: unknown; salience?: unknown; evidence?: unknown }>;
      facts?: Array<{ content?: unknown; type?: unknown; entityIds?: unknown[] }>;
    };
    let sourceTitle = decision?.sourceTitle ?? payload.sourceId;
    let mentions: RelationIndexInput["mentions"] = [];
    if (Array.isArray(evidence.entities)) {
      mentions = evidence.entities.flatMap((item) => typeof item.entityId === "string" ? [{
        entityId: item.entityId,
        salience: typeof item.salience === "number" ? item.salience : 0.5,
        evidence: typeof item.evidence === "string" ? item.evidence : null,
      }] : []);
    }
    let facts: RelationIndexInput["facts"] = [];
    if (Array.isArray(evidence.facts)) {
      facts = evidence.facts.flatMap((item) => {
        if (typeof item.content !== "string" || !item.content.trim()) return [];
        return [{
          content: item.content,
          type: item.type === "关系" ? "关系" as const : "属性" as const,
          entityIds: (item.entityIds ?? []).flatMap((entityId) => typeof entityId === "string" ? [entityId] : []),
        }];
      });
    }
    // 兜底抽取：mentions 或 facts 任一缺失且 LLM 可用即补抽一次（入口文档 ED5 无路由抽取，靠这里补实体+事实）
    if ((mentions.length === 0 || facts.length === 0) && this.llm) {
      let envelope: DocEnvelope | null = null;
      if (payload.sourceKind === "everroom-doc") {
        const document = this.getDocument(payload.sourceId);
        if (!document || document.version !== payload.sourceVersion) return;
        sourceTitle = document.title;
        envelope = buildDocumentEnvelope({ ...document, roomId: activeRoomIds[0]! });
      } else if (decision?.sourceMarkdown) {
        envelope = {
          ref: { kind: payload.sourceKind, id: payload.sourceId, version: payload.sourceVersion },
          title: decision.sourceTitle ?? payload.sourceId,
          markdown: decision.sourceMarkdown,
        };
      }
      if (envelope) {
        const extracted = await this.llm.extract(envelope.title, envelope.markdown);
        const extractedEntityIds = new Map(extracted.entities.map((item) =>
          [item.name, this.relationRegistry.resolveMentionEntity(item.name, item.kind)]));
        if (mentions.length === 0) {
          mentions = extracted.entities.map((item) => ({
            entityId: extractedEntityIds.get(item.name)!,
            salience: item.salience,
            evidence: item.evidence || null,
          }));
        }
        if (facts.length === 0) {
          facts = extracted.facts.map((fact) => ({
            content: fact.content,
            type: fact.type,
            entityIds: fact.entities.flatMap((name) => {
              const entityId = extractedEntityIds.get(name);
              return entityId ? [entityId] : [];
            }),
          }));
        }
      }
    } else if (mentions.length === 0) {
      this.relationRegistry.markIndexing("degraded");
    }
    const roomRoles: RelationIndexInput["roomRoles"] = {};
    for (const roomId of activeRoomIds) {
      roomRoles[roomId] = decision?.decidedBy === "entry"
        ? "entry"
        : decision?.decidedBy === "rule"
          ? "rule"
          : decision?.decidedBy === "user" ? "manual" : "primary";
    }
    for (const item of evidence.entities ?? []) {
      if (typeof item.entityId !== "string") continue;
      const entity = this.entityRegistry.getEntity(item.entityId);
      if (entity?.roomId && activeRoomIds.includes(entity.roomId)) {
        roomRoles[entity.roomId] = item.role === "mention" ? "mention" : item.role === "manual" ? "manual" : "primary";
      }
    }
    this.relationRegistry.replaceSource({
      sourceKind: payload.sourceKind,
      sourceId: payload.sourceId,
      sourceVersion: payload.sourceVersion,
      sourceTitle,
      roomIds: activeRoomIds,
      roomRoles,
      mentions,
      facts,
    });
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

    const filename = envelopeFilename(envelope);
    if (ingestLedgerOf(decision).some((entry) => entry.roomId === payload.roomId && entry.filename === filename)) {
      this.logger.info(
        { event: "knowledge.ingest.already_confirmed", sourceId: payload.sourceId, roomId: payload.roomId },
        "document already present in room wiki, skipping duplicate job",
      );
      return;
    }
    const knowledgeId = await this.registry.ensureWikiForRoom(payload.roomId);

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
   * 弱实体 → Room 的创建流程：同名扫描 → 转正登记 → rooms 插行 →
   * 将全部链接资料（不分角色，每源最新版本）展开为后台 ingest job。
   *
   * 幂等性：room 行已建（roomId 回填）时只补排 backlog；重复 ingest job
   * 在 runIngestJob 通过 Room/filename 台账跳过。
   */
  private async runPromotionJob(jobId: string, payload: PromoteJobPayload): Promise<void> {
    const entity = this.entityRegistry.getEntity(payload.entityId);
    if (!entity || entity.status === "archived") return;

    if (entity.roomId) {
      // 已建 Room（含崩溃恢复/重复入队）：补账拆成普通 ingest job，
      // 不让慢 Wiki 阻塞其他 Room 的创建。
      const queued = this.enqueueEntityBacklog(entity.id);
      this.setPromotionProgress(jobId, "importing_documents", `已安排 ${String(queued)} 份资料后台导入`, 0, queued, entity.roomId);
      this.enqueueEntityRelationBacklog(entity.id, entity.roomId);
      return;
    }
    if (entity.status !== "weak" && entity.status !== "ready" && entity.status !== "promoting") return;
    if (!this.entityRegistry.claimForPromotion(entity.id)) return; // 并行晋升在处理：静默退出

    // 步骤 2：同名扫描——撞已晋升实体（Dice ≥ judge 线）→ LLM 同一性判定
    const collision = payload.forceNew
      ? { outcome: "promote" as const, target: null, reason: "用户确认保留为独立 Room" }
      : await this.scanPromotedCollision(entity);
    if (collision.outcome === "hold") {
      // 判定失败：保留 promoting 与任务进度，交给 worker 退避重试。
      throw new Error(`promotion identity judge failed for entity ${entity.id}`);
    }
    if (collision.target) {
      // 判定同一：弱实体整体并入既有实体，不建新 Room（验收 4：同名不重建）
      this.entityRegistry.mergeEntities({
        intoId: collision.target.id,
        fromId: entity.id,
        reason: collision.reason,
      });
      this.relationRegistry.rewriteEntity(entity.id, collision.target.id);
      const queued = this.enqueueEntityBacklog(collision.target.id);
      if (collision.target.roomId) this.enqueueEntityRelationBacklog(collision.target.id, collision.target.roomId);
      this.setPromotionProgress(
        jobId,
        "importing_documents",
        `已安排 ${String(queued)} 份资料后台导入`,
        0,
        queued,
        collision.target.roomId,
      );
      this.logger.info(
        { event: "knowledge.entity.merged_on_promote", fromId: entity.id, intoId: collision.target.id, reason: collision.reason },
        "weak entity merged into existing promoted entity",
      );
      return;
    }

    // 步骤 3：转正登记（LLM 一次；失败用现有 name + 首条依据拼底稿）
    this.setPromotionProgress(jobId, "registering_entity", "正在整理 Room 名称与概述", 2, 5);
    const registration = await this.registerEntityOrFallback(entity);

    // 步骤 4：rooms 插行 + status=room + roomId 回填——先于链接查询（竞态防护：
    // 晋升中途到达的链接，其资料经 backlog 补账不会被漏掉）
    this.setPromotionProgress(jobId, "creating_room", "正在创建 Room", 3, 5);
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

    // 资料沉淀拆为 per-room 串行的普通 ingest job。Room 创建在这里即可完成，
    // 后台 Wiki 处理不会继续占用高优先级 promotion worker。
    const queued = this.enqueueEntityBacklog(entity.id);
    this.enqueueEntityRelationBacklog(entity.id, roomId);
    this.setPromotionProgress(jobId, "importing_documents", `已安排 ${String(queued)} 份资料后台导入`, 0, queued, roomId);
    this.logger.info(
      { event: "knowledge.entity.promoted", entityId: entity.id, roomId, name: registration.name, manual: payload.manual ?? false },
      "weak entity promoted to room",
    );
  }

  private enqueueEntityRelationBacklog(entityId: string, roomId: string): void {
    for (const link of this.entityRegistry.linksOfEntity(entityId)) {
      const decision = this.db.select().from(routeDecisions).where(and(
        eq(routeDecisions.sourceKind, link.sourceKind),
        eq(routeDecisions.sourceId, link.sourceId),
      )).orderBy(desc(routeDecisions.createdAt)).get();
      const evidence = (decision?.evidence ?? {}) as { rooms?: Array<{ roomId?: unknown }>; linkOnlyRooms?: unknown[] };
      const roomIds = new Set<string>([roomId]);
      if (decision?.primaryRoomId) roomIds.add(decision.primaryRoomId);
      for (const linked of decision?.linkedRoomIds ?? []) roomIds.add(linked);
      for (const entry of evidence.rooms ?? []) if (typeof entry.roomId === "string") roomIds.add(entry.roomId);
      for (const linked of evidence.linkOnlyRooms ?? []) if (typeof linked === "string") roomIds.add(linked);
      this.insertJob(ROOM_RELATION_INDEX_JOB_TYPE, {
        sourceKind: link.sourceKind,
        sourceId: link.sourceId,
        sourceVersion: link.sourceVersion,
        roomIds: [...roomIds],
      });
    }
    this.wake();
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
   * 将实体存量资料展开成普通 ingest job。创建 Room 只负责落库和排队，
   * 资料写入沿用 per-room 锁、失败重试和统一 worker，不阻塞创建队列。
   */
  private enqueueEntityBacklog(entityId: string): number {
    const entity = this.entityRegistry.getEntity(entityId);
    if (!entity?.roomId) return 0;

    const latestBySource = new Map<string, EntityLinkRow>();
    for (const link of this.entityRegistry.linksOfEntity(entityId)) {
      const key = `${link.sourceKind}:${link.sourceId}`;
      const existing = latestBySource.get(key);
      if (!existing || link.sourceVersion > existing.sourceVersion) latestBySource.set(key, link);
    }

    let queued = 0;
    for (const link of latestBySource.values()) {
      const decision = this.db.select().from(routeDecisions)
        .where(and(
          eq(routeDecisions.sourceKind, link.sourceKind),
          eq(routeDecisions.sourceId, link.sourceId),
        ))
        .orderBy(desc(routeDecisions.createdAt))
        .get();
      if (!decision) continue;
      this.insertJob(INGEST_JOB_TYPE, {
        sourceKind: link.sourceKind,
        sourceId: link.sourceId,
        sourceVersion: link.sourceVersion,
        roomId: entity.roomId,
        decisionId: decision.id,
      });
      queued += 1;
    }
    if (queued > 0) this.wake();
    return queued;
  }

  /**
   * 批量补账：把实体全部链接（不分角色——mention 链接的实体晋升后
   * 同样收正文）的资料（每源最新版本）落进实体 Room 的 wiki。收敛循环
   * 兜住晋升/合并中途到达的新链接；账本已含 {roomId, filename} 者跳过
   * （幂等，重复入队零副作用，其他 Room 的确认不挡本房补账）。
   */
  private async ingestEntityBacklog(
    entityId: string,
    onProgress?: (stage: PromotionStage, message: string, current?: number, total?: number) => void,
  ): Promise<void> {
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
      let processed = 0;
      const total = latestBySource.size;
      if (pass === 0) onProgress?.("creating_wiki", "正在准备 Room Wiki", 4, 5);
      for (const link of latestBySource.values()) {
        onProgress?.("importing_documents", `正在导入资料 ${String(processed)}/${String(total)}`, processed, total);
        const decision = this.db.select().from(routeDecisions)
          .where(and(
            eq(routeDecisions.sourceKind, link.sourceKind),
            eq(routeDecisions.sourceId, link.sourceId),
          ))
          .orderBy(desc(routeDecisions.createdAt))
          .get();
        if (!decision) {
          processed += 1;
          onProgress?.("importing_documents", `正在导入资料 ${String(processed)}/${String(total)}`, processed, total);
          continue; // 无决策行（信封已丢）：跳过，链接仍在
        }

        // 台账快照过滤（§6.3）：wiki=false 的源晋升补账也只计链接分
        if (this.wikiDisabledForSource(link.sourceKind, link.sourceId)) {
          if (!ingestLedgerOf(decision).some((entry) => entry.roomId === roomId)
            && !linkOnlyRoomsOf(decision).includes(roomId)) {
            this.db.update(routeDecisions).set({
              evidence: markLinkOnlyRoom(decision.evidence, roomId),
              updatedAt: new Date(),
            }).where(eq(routeDecisions.id, decision.id)).run();
          }
          processed += 1;
          onProgress?.("importing_documents", `正在导入资料 ${String(processed)}/${String(total)}`, processed, total);
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
        if (!envelope) {
          processed += 1;
          onProgress?.("importing_documents", `正在导入资料 ${String(processed)}/${String(total)}`, processed, total);
          continue;
        }
        const filename = envelopeFilename(envelope);
        // 账本制跳过：本房本文件已沉淀过才跳——多对多下其他 Room 的
        // 确认（primaryRoomId 指向别房）不是跳过理由
        if (ingestLedgerOf(decision).some((entry) => entry.roomId === roomId && entry.filename === filename)) {
          processed += 1;
          onProgress?.("importing_documents", `正在导入资料 ${String(processed)}/${String(total)}`, processed, total);
          continue;
        }

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
        processed += 1;
        onProgress?.("importing_documents", `正在导入资料 ${String(processed)}/${String(total)}`, processed, total);
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
    this.entityRegistry.removeSourceLinks(payload.sourceKind, payload.sourceId);
    this.relationRegistry.removeSource(payload.sourceKind, payload.sourceId);
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

  private existingRoomMatch(entity: EntityRow): ExistingRoomMatch | null {
    if (entity.status === "room" || entity.status === "archived" || entity.roomId) return null;
    const sourceGroups = new Set(this.entityRegistry.linksOfEntity(entity.id)
      .filter((link) => link.trusted && (link.qualityLevel === "normal" || link.qualityLevel === "high"))
      .map((link) => link.evidenceGroupKey));
    const activeRooms = new Map(this.db.select().from(rooms)
      .where(and(isNull(rooms.deletedAt), eq(rooms.lifecycle, "active"))).all()
      .map((room) => [room.id, room]));
    const trustedMentions = this.db.select().from(roomEntityMentions).all()
      .filter((mention) => mention.trusted && (mention.qualityLevel === "normal" || mention.qualityLevel === "high"));
    const sourceEntityIds = new Set(trustedMentions
      .filter((mention) => sourceGroups.has(mention.evidenceGroupKey))
      .map((mention) => mention.entityId));

    let best: ExistingRoomMatch | null = null;
    for (const target of this.entityRegistry.listEntities("room")) {
      if (!target.roomId) continue;
      const room = activeRooms.get(target.roomId);
      if (!room) continue;

      let nameScore = 0;
      for (const name of [entity.name, ...entity.aliases]) {
        nameScore = Math.max(nameScore, bestMatch(name, [target.name, ...target.aliases])?.score ?? 0);
      }
      const centroidScore = entity.centroid && target.centroid && entity.centroidModel === target.centroidModel
        ? Math.max(0, cosineSimilarity(decodeCentroid(entity.centroid), decodeCentroid(target.centroid)))
        : 0;
      const targetGroups = new Set(this.entityRegistry.linksOfEntity(target.id)
        .filter((link) => link.trusted && (link.qualityLevel === "normal" || link.qualityLevel === "high"))
        .map((link) => link.evidenceGroupKey));
      const overlapBase = Math.min(sourceGroups.size, targetGroups.size);
      const contentOverlap = overlapBase > 0
        ? [...sourceGroups].filter((group) => targetGroups.has(group)).length / overlapBase
        : 0;
      const targetEntityIds = new Set(trustedMentions
        .filter((mention) => mention.roomId === room.id)
        .map((mention) => mention.entityId));
      let entityIntersection = 0;
      for (const entityId of sourceEntityIds) if (targetEntityIds.has(entityId)) entityIntersection += 1;
      const entityUnion = sourceEntityIds.size + targetEntityIds.size - entityIntersection;
      const entityOverlap = entityUnion > 0 ? entityIntersection / entityUnion : 0;
      const score = Math.round((nameScore * 0.3 + centroidScore * 0.3 + contentOverlap * 0.25 + entityOverlap * 0.15) * 10_000) / 10_000;
      const sameKind = entity.kind === target.kind;
      const exactName = nameScore === 1;
      const confidence = sameKind && (exactName || (score >= 0.82 && (contentOverlap >= 0.5 || entityOverlap >= 0.35)))
        ? "high"
        : sameKind && score >= 0.68 ? "medium" : null;
      if (!confidence) continue;
      const reasons = [
        ...(exactName ? ["exact_name_or_alias"] : nameScore >= 0.6 ? ["similar_name_or_alias"] : []),
        ...(centroidScore >= 0.82 ? ["similar_centroid"] : []),
        ...(contentOverlap >= 0.35 ? ["shared_evidence"] : []),
        ...(entityOverlap >= 0.4 ? ["shared_entities"] : []),
      ];
      const match = { roomId: room.id, roomTitle: room.title, entityId: target.id, confidence, score, reasons } satisfies ExistingRoomMatch;
      if (!best || confidence === "high" && best.confidence !== "high" || confidence === best.confidence && score > best.score) {
        best = match;
      }
    }
    return best;
  }

  /** 候选实体列表（默认 weak；ready = 推荐池，首页"推荐 Room"数据源）。 */
  listCandidateEntities(status: "weak" | "ready" | "promoting" | "room" | "archived" | "suppressed" = "weak"): Array<{
    id: string;
    name: string;
    kind: string;
    status: string;
    roomId: string | null;
    evidenceScore: number;
    sourceCount: number;
    eligibleSourceCount: number;
    trustedSourceCount: number;
    strongSourceCount: number;
    readinessPath: "standard" | "strong" | null;
    sourceKinds: SourceKind[];
    excludedSourceCount: number;
    promoteScore: number;
    promoteSources: number;
    firstEvidence: string | null;
    lastLinkedAt: Date | null;
    updatedAt: Date;
    promotion: PromotionProgress | null;
    existingRoomMatch: ExistingRoomMatch | null;
  }> {
    return this.entityRegistry.listEntities(status)
      .slice(0, LIST_PAGE_SIZE)
      .map((entity) => {
        const links = this.entityRegistry.linksOfEntity(entity.id);
        const sourceKinds = [...new Set(links
          .filter((link) => link.effectiveWeight > 0)
          .sort((a, b) => b.effectiveWeight - a.effectiveWeight)
          .map((link) => link.sourceKind))].slice(0, 3);
        return {
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        status: entity.status,
        roomId: entity.roomId,
        evidenceScore: entity.evidenceScore,
        sourceCount: entity.sourceCount,
        eligibleSourceCount: entity.eligibleSourceCount,
        trustedSourceCount: entity.trustedSourceCount,
        strongSourceCount: entity.strongSourceCount,
        readinessPath: entity.readinessPath,
        sourceKinds,
        excludedSourceCount: links.filter((link) => link.effectiveWeight === 0).length,
        promoteScore: this.config.entityPromoteScore,
        promoteSources: this.config.entityPromoteSources,
        firstEvidence: this.evidenceSamplesOf(entity.id)[0] ?? null,
        lastLinkedAt: entity.lastLinkedAt,
        updatedAt: entity.updatedAt,
        promotion: this.promotionProgress(entity.id),
        existingRoomMatch: this.existingRoomMatch(entity),
      };
      });
  }

  suppressEntity(entityId: string): { ok: true } | { ok: false; error: string } {
    const entity = this.entityRegistry.getEntity(entityId);
    if (!entity) return { ok: false, error: "entity_not_found" };
    if (entity.status !== "weak" && entity.status !== "ready") return { ok: false, error: "entity_not_suppressible" };
    this.entityRegistry.suppress(entityId);
    return { ok: true };
  }

  restoreSuppressedEntity(entityId: string): { ok: true } | { ok: false; error: string } {
    const entity = this.entityRegistry.getEntity(entityId);
    if (!entity) return { ok: false, error: "entity_not_found" };
    if (entity.status !== "suppressed") return { ok: false, error: "entity_not_suppressed" };
    this.entityRegistry.restoreSuppressed(entityId);
    return { ok: true };
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

  /** Room 创建进度：优先返回仍在执行的任务，否则返回最近一次结果。 */
  promotionProgress(entityId: string): PromotionProgress | null {
    const promotionJobs = this.db.select().from(jobs)
      .where(eq(jobs.type, PROMOTE_JOB_TYPE))
      .orderBy(asc(jobs.createdAt))
      .all()
      .filter((job) => job.status !== "cancelled"
        && (job.payload as PromoteJobPayload).entityId === entityId);
    const job = promotionJobs.find((candidate) => candidate.status === "running")
      ?? promotionJobs.find((candidate) => candidate.status === "pending")
      ?? promotionJobs.at(-1);
    if (!job) return null;
    const result = (job.result ?? {}) as Partial<PromotionJobResult>;
    const error = (job.error ?? {}) as { message?: unknown };
    const status = job.status === "pending" ? "queued"
      : job.status === "running" ? "running"
        : job.status === "completed" ? "completed" : "failed";
    const stage = result.stage
      ?? (status === "queued" ? "queued" : status === "completed" ? "completed" : status === "failed" ? "failed" : "checking_identity");
    const defaultMessage = status === "queued" ? "已加入 Room 创建队列"
      : status === "running" ? "正在创建 Room"
        : status === "completed" ? "Room 与知识资料已创建完成" : "Room 创建失败";
    const pending = status === "queued"
      ? this.db.select().from(jobs).where(and(eq(jobs.type, PROMOTE_JOB_TYPE), eq(jobs.status, "pending")))
        .orderBy(asc(jobs.createdAt)).all()
      : [];
    const queueIndex = pending.findIndex((candidate) => candidate.id === job.id);
    return {
      jobId: job.id,
      status,
      stage,
      message: result.message ?? defaultMessage,
      current: typeof result.current === "number" ? result.current : null,
      total: typeof result.total === "number" ? result.total : null,
      queuePosition: queueIndex >= 0 ? queueIndex + 1 : null,
      roomId: typeof result.roomId === "string" ? result.roomId : null,
      error: typeof error.message === "string" ? error.message : null,
      updatedAt: job.updatedAt,
    };
  }

  private activePromotionJob(entityId: string): typeof jobs.$inferSelect | null {
    return this.db.select().from(jobs)
      .where(and(eq(jobs.type, PROMOTE_JOB_TYPE), inArray(jobs.status, ["pending", "running"])))
      .orderBy(asc(jobs.createdAt))
      .all()
      .find((job) => (job.payload as PromoteJobPayload).entityId === entityId) ?? null;
  }

  private deduplicatePendingPromotions(): number {
    const pending = this.db.select().from(jobs)
      .where(and(eq(jobs.type, PROMOTE_JOB_TYPE), eq(jobs.status, "pending")))
      .orderBy(asc(jobs.createdAt))
      .all();
    const canonicalByEntity = new Map<string, string>();
    let cancelled = 0;
    for (const job of pending) {
      const entityId = (job.payload as PromoteJobPayload).entityId;
      if (!entityId) continue;
      const canonicalJobId = canonicalByEntity.get(entityId);
      if (!canonicalJobId) {
        canonicalByEntity.set(entityId, job.id);
        continue;
      }
      const result = this.db.update(jobs).set({
        status: "cancelled",
        result: {
          ...((job.result ?? {}) as Record<string, unknown>),
          stage: "queued",
          message: "重复请求已合并到已有创建任务",
          supersededBy: canonicalJobId,
        },
        updatedAt: new Date(),
      }).where(and(eq(jobs.id, job.id), eq(jobs.status, "pending"))).run() as { changes: number | bigint };
      cancelled += Number(result.changes);
    }
    return cancelled;
  }

  /** 热重载或重复补账可能留下完全相同的活动任务；保留最早一条即可。 */
  private deduplicatePendingJobs(): number {
    const pending = this.db.select().from(jobs)
      .where(and(eq(jobs.status, "pending"), inArray(jobs.type, [INGEST_JOB_TYPE, ROUTE_JOB_TYPE, CLEANUP_JOB_TYPE, ROOM_RELATION_INDEX_JOB_TYPE])))
      .orderBy(asc(jobs.createdAt))
      .all();
    const canonicalByPayload = new Map<string, string>();
    let cancelled = 0;
    for (const job of pending) {
      const key = `${job.type}:${JSON.stringify(job.payload)}`;
      const canonicalJobId = canonicalByPayload.get(key);
      if (!canonicalJobId) {
        canonicalByPayload.set(key, job.id);
        continue;
      }
      const result = this.db.update(jobs).set({
        status: "cancelled",
        result: { message: "重复任务已合并到已有任务", supersededBy: canonicalJobId },
        updatedAt: new Date(),
      }).where(and(eq(jobs.id, job.id), eq(jobs.status, "pending"))).run() as { changes: number | bigint };
      cancelled += Number(result.changes);
    }
    return cancelled;
  }

  private setPromotionProgress(
    jobId: string,
    stage: PromotionStage,
    message: string,
    current?: number,
    total?: number,
    roomId?: string | null,
  ): void {
    const existing = this.db.select({ result: jobs.result }).from(jobs).where(eq(jobs.id, jobId)).get();
    this.db.update(jobs).set({
      result: {
        ...((existing?.result ?? {}) as Record<string, unknown>),
        stage,
        message,
        ...(current !== undefined ? { current } : {}),
        ...(total !== undefined ? { total } : {}),
        ...(roomId ? { roomId } : {}),
      },
      updatedAt: new Date(),
    }).where(eq(jobs.id, jobId)).run();
  }

  /**
   * 用户确认创建（推荐确认制的唯一建 Room 入口）：ready/weak 实体走完整
   * 晋升流程（含同名扫描与 LLM 转正登记）。用户出手即是明确信号——
   * 不设阈值门槛（ED8 修订：建 Room 收回用户确认权）。
   */
  promoteEntity(entityId: string, options?: { forceNew?: boolean }): { ok: true; queued: boolean; jobId: string } | { ok: false; error: string } {
    const entity = this.entityRegistry.getEntity(entityId);
    if (!entity) return { ok: false, error: "entity_not_found" };
    const active = this.activePromotionJob(entityId);
    if (active) return { ok: true, queued: false, jobId: active.id };
    if (entity.status !== "weak" && entity.status !== "ready") {
      return { ok: false, error: "entity_not_promotable" };
    }
    const existingRoomMatch = this.existingRoomMatch(entity);
    if (existingRoomMatch?.confidence === "high") {
      return { ok: false, error: "existing_room_match_high_confidence" };
    }
    if (existingRoomMatch && !options?.forceNew) {
      return { ok: false, error: "existing_room_review_required" };
    }
    const jobId = this.insertJob(
      PROMOTE_JOB_TYPE,
      { entityId, manual: true, forceNew: options?.forceNew === true, previousStatus: entity.status },
      { stage: "queued", message: "已加入 Room 创建队列", current: 0, total: 5 },
    );
    this.entityRegistry.claimForPromotion(entityId);
    this.wake();
    return { ok: true, queued: true, jobId };
  }

  /** 推荐池批量确认：逐项回算门槛并幂等入队，允许部分成功。 */
  promoteEntities(entityIds: string[]): Array<{
    entityId: string;
    status: "queued" | "already_queued" | "rejected";
    jobId: string | null;
    error: string | null;
  }> {
    return [...new Set(entityIds)].slice(0, 20).map((entityId) => {
      const active = this.activePromotionJob(entityId);
      if (active) return { entityId, status: "already_queued" as const, jobId: active.id, error: null };
      const entity = this.entityRegistry.recomputeEntity(entityId);
      if (!entity) return { entityId, status: "rejected" as const, jobId: null, error: "entity_not_found" };
      if (entity.status !== "ready") {
        return { entityId, status: "rejected" as const, jobId: null, error: "recommendation_below_threshold" };
      }
      if (this.existingRoomMatch(entity)) {
        return { entityId, status: "rejected" as const, jobId: null, error: "existing_room_review_required" };
      }
      const promoted = this.promoteEntity(entityId);
      if (!promoted.ok) return { entityId, status: "rejected" as const, jobId: null, error: promoted.error };
      return {
        entityId,
        status: promoted.queued ? "queued" as const : "already_queued" as const,
        jobId: promoted.jobId,
        error: null,
      };
    });
  }

  /** 推荐池批量忽略：幂等处理 suppressed，逐项返回结果。 */
  suppressEntities(entityIds: string[]): Array<{
    entityId: string;
    status: "suppressed" | "already_suppressed" | "rejected";
    error: string | null;
  }> {
    return [...new Set(entityIds)].slice(0, 20).map((entityId) => {
      const entity = this.entityRegistry.getEntity(entityId);
      if (!entity) return { entityId, status: "rejected" as const, error: "entity_not_found" };
      if (entity.status === "suppressed") {
        return { entityId, status: "already_suppressed" as const, error: null };
      }
      const suppressed = this.suppressEntity(entityId);
      if (!suppressed.ok) return { entityId, status: "rejected" as const, error: suppressed.error };
      return { entityId, status: "suppressed" as const, error: null };
    });
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
    if (from.roomId) {
      return { ok: false, error: "room_merge_confirmation_required" };
    }

    // 仅候选实体可以复用已有 Room。Room 对 Room 必须走不可撤销合并的
    // preview + 用户确认流程，不能从旧实体治理接口旁路执行。
    this.entityRegistry.mergeEntities({ intoId: into.id, fromId: from.id, reason: "用户手动合并" });
    this.relationRegistry.rewriteEntity(from.id, into.id);
    if (into.roomId) {
      this.enqueueEntityBacklog(into.id);
      this.enqueueEntityRelationBacklog(into.id, into.roomId);
      this.wake();
    } else {
      await this.ingestEntityBacklog(into.id);
    }
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
      // upsertLink 已按 V2 规则回算 weak/ready；创建仍等待用户确认。
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

  roomGraph(visibility: RoomRelationVisibility = "active"): RoomGraphDto {
    return this.relationRegistry.graph(visibility);
  }

  roomRelations(roomId: string, visibility: RoomRelationVisibility = "active"): RoomGraphDto | null {
    return this.relationRegistry.relationsOfRoom(this.canonicalRoomId(roomId), visibility);
  }

  roomRelationEvidence(id: string, offset = 0, limit = 50) {
    return this.relationRegistry.relationEvidence(id, offset, limit);
  }

  createRoomRelation(input: {
    fromRoomId: string;
    toRoomId: string;
    type: RoomRelationManualType;
    directed?: boolean;
    label?: string | null;
    note?: string | null;
  }): RoomRelationDto | null {
    const relation = this.relationRegistry.createManual({
      ...input,
      fromRoomId: this.canonicalRoomId(input.fromRoomId),
      toRoomId: this.canonicalRoomId(input.toRoomId),
    });
    this.roomDuplicateIndexTrigger?.();
    return relation;
  }

  updateRoomRelation(id: string, input: Parameters<RoomRelationRegistry["updateManual"]>[1]): RoomRelationDto | null {
    const relation = this.relationRegistry.updateManual(id, input);
    this.roomDuplicateIndexTrigger?.();
    return relation;
  }

  removeManualRoomRelation(id: string): RoomRelationDto | null | undefined {
    const relation = this.relationRegistry.removeManual(id);
    this.roomDuplicateIndexTrigger?.();
    return relation;
  }

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
    const conditions = [isNull(rooms.deletedAt), eq(rooms.lifecycle, "active")];
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
    if (existing && existing.lifecycle !== "active") {
      const canonical = this.db.select().from(rooms).where(eq(rooms.id, this.canonicalRoomId(input.id))).get();
      return this.toRoomDto(canonical ?? existing);
    }
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
    this.relationRegistry.recomputeAll();
    this.roomDuplicateIndexTrigger?.();
    return this.toRoomDto(row!);
  }

  /**
   * 手动建 Room 的实体认领（ContextRoom enrich 回写触发）：绑定后本 Room
   * 成为路由目标，后续资料解析命中这些实体即沉淀进来（与推荐晋升同语义）。
   * 返回实际认领数。
   */
  claimRoomEntities(roomId: string, entities: Array<{ name: string; kind: string }>): number {
    const canonical = this.canonicalRoomId(roomId);
    const claimed = this.entityRegistry.claimEntitiesForRoom(canonical, entities);
    if (claimed > 0) {
      this.relationRegistry.recomputeAll();
      this.roomDuplicateIndexTrigger?.();
    }
    return claimed;
  }

  /** 软删除（默认策略：wiki 归档不删、documents/links 保留、候选池剔除）。 */
  deleteRoom(roomId: string): boolean {
    const existing = this.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).get();
    if (!existing) return false;
    void this.retireRoomWiki(roomId, "渲染器上报删除");
    this.db.update(entitiesTable).set({ status: "archived", updatedAt: new Date() })
      .where(eq(entitiesTable.roomId, roomId)).run();
    this.relationRegistry.recomputeAll();
    this.roomDuplicateIndexTrigger?.();
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
    roomId = this.canonicalRoomId(roomId);
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

  /** Room 详情投影：资料集合是事实源，LLM 只负责汇总，不直接改用户 Room 数据。 */
  async roomContext(roomId: string): Promise<RoomContextSummary> {
    roomId = this.canonicalRoomId(roomId);
    const rows = this.db.select({ document: documents })
      .from(roomDocumentLinks)
      .innerJoin(documents, eq(roomDocumentLinks.documentId, documents.id))
      .where(and(eq(roomDocumentLinks.roomId, roomId), isNull(documents.deletedAt)))
      .orderBy(desc(documents.updatedAt))
      .all()
      .filter(({ document }) => document.status === "active");
    const sourceDocuments = rows.map(({ document }) => ({
      documentId: document.id,
      title: document.title,
      version: document.version,
      updatedAt: document.updatedAt.toISOString(),
    }));
    // 已路由进本 Room 的连接器邮件/日历：详情的日程、待办生成由此覆盖（正文取路由审计快照）。
    const connectorSources = this.roomConnectorSources(roomId);
    const key = [
      ...sourceDocuments.map((item) => `${item.documentId}:${item.version}`),
      ...connectorSources.map((item) => `${item.sourceKind}:${item.sourceId}:${item.version}`),
    ].join("\u0000");
    const cached = this.roomContextCache.get(roomId);
    if (cached?.key === key) return cached.value;

    const fallbackStatus = sourceDocuments.length > 0
      ? `已收录 ${sourceDocuments.length} 份文档，最新资料《${sourceDocuments[0]!.title}》已更新。`
      : "";
    let context: RoomContextResult = {
      overview: fallbackStatus,
      status: fallbackStatus,
      nextSteps: [],
      entities: [],
      actionItems: [],
      meetings: [],
    };
    const sourceCount = rows.length + connectorSources.length;
    let cacheable = !this.llm || sourceCount === 0;
    if (this.llm && sourceCount > 0) {
      const room = this.db.select({ title: rooms.title }).from(rooms).where(eq(rooms.id, roomId)).get();
      try {
        const generated = await this.llm.summarizeRoom(
          room?.title ?? roomId,
          [
            ...rows.map(({ document }) => ({
              title: document.title,
              markdown: tiptapToMarkdown(document.contentJson as TiptapJsonContent),
            })),
            ...connectorSources.map((item) => ({
              title: item.title,
              markdown: item.markdown,
              label: item.sourceKind === "calendar-event"
                ? "日历事件"
                : item.sourceKind === "todo" ? "待办" : "邮件",
            })),
          ],
        );
        const sourceTitles = new Set([
          ...sourceDocuments.map((document) => document.title),
          ...connectorSources.map((item) => item.title),
        ]);
        context = {
          ...generated,
          status: generated.status || fallbackStatus,
          actionItems: generated.actionItems.filter((item) => sourceTitles.has(item.sourceTitle)),
          meetings: generated.meetings.filter((item) => sourceTitles.has(item.sourceTitle)),
        };
        cacheable = true;
      } catch (error) {
        this.logger.warn(
          { event: "knowledge.room_context.failed", roomId, error: error instanceof Error ? error.message : String(error) },
          "Room context refresh failed; using document fallback",
        );
      }
    }
    const value: RoomContextSummary = {
      roomId,
      generatedAt: new Date().toISOString(),
      sourceDocuments,
      sourceConnectors: connectorSources.map(({ sourceKind, sourceId, version, title }) => ({
        sourceKind, sourceId, version, title,
      })),
      ...context,
    };
    if (cacheable) this.roomContextCache.set(roomId, { key, value });
    return value;
  }

  /**
   * 本 Room 已路由命中的连接器来源（邮件/日历）：按 (kind,id) 取最新一版
   * route_decisions 的正文快照，按路由时间倒序截 8 条（LLM 预算内，排在文档之后）。
   * nango 历史日历曾落 "mail" kind，一并列回收敛。
   */
  private roomConnectorSources(roomId: string): Array<{
    sourceKind: "mail" | "calendar-event" | "todo";
    sourceId: string;
    version: number;
    title: string;
    markdown: string;
  }> {
    const memberships = this.db.select({
      sourceKind: roomSourceMemberships.sourceKind,
      sourceId: roomSourceMemberships.sourceId,
    })
      .from(roomSourceMemberships)
      .where(and(
        eq(roomSourceMemberships.roomId, roomId),
        inArray(roomSourceMemberships.sourceKind, ["mail", "calendar-event", "todo"]),
      ))
      .all();
    if (memberships.length === 0) return [];
    const snapshots = this.db.select({
      sourceKind: routeDecisions.sourceKind,
      sourceId: routeDecisions.sourceId,
      sourceVersion: routeDecisions.sourceVersion,
      sourceTitle: routeDecisions.sourceTitle,
      sourceMarkdown: routeDecisions.sourceMarkdown,
      createdAt: routeDecisions.createdAt,
    })
      .from(routeDecisions)
      .where(and(
        inArray(routeDecisions.sourceKind, ["mail", "calendar-event", "todo"]),
        or(...memberships.map((item) =>
          and(eq(routeDecisions.sourceKind, item.sourceKind), eq(routeDecisions.sourceId, item.sourceId)))),
        isNotNull(routeDecisions.sourceMarkdown),
      ))
      .orderBy(desc(routeDecisions.sourceVersion))
      .all();
    const latest = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      const key = `${snapshot.sourceKind}\x00${snapshot.sourceId}`;
      if (!latest.has(key)) latest.set(key, snapshot);
    }
    return [...latest.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 8)
      .map((snapshot) => ({
        sourceKind: snapshot.sourceKind as "mail" | "calendar-event" | "todo",
        sourceId: snapshot.sourceId,
        version: snapshot.sourceVersion,
        title: snapshot.sourceTitle?.trim() || "（无标题）",
        markdown: snapshot.sourceMarkdown ?? "",
      }))
      .filter((item) => item.markdown.length > 0);
  }
}

export interface RoomContextSummary extends RoomContextResult {
  roomId: string;
  generatedAt: string;
  sourceDocuments: Array<{
    documentId: string;
    title: string;
    version: number;
    updatedAt: string;
  }>;
  /** 参与本次生成的已路由连接器来源（邮件/日历），供前端展示与测试断言。 */
  sourceConnectors: Array<{
    sourceKind: "mail" | "calendar-event" | "todo";
    sourceId: string;
    version: number;
    title: string;
  }>;
}
