import {
  applyOutcome,
  markRetrieved,
  createMemory,
  deleteEntry,
  initStore,
  loadAllEntries,
  readEntry,
  search,
  sleep,
  writeEntry,
  type HippoMemoryEntry,
  type HippoSleepResult,
} from "hippo-memory";
import { isSearchKey, needsSegmentation, searchKeys, toHippoQuery } from "./cjk.js";
import { LESSON_TAG } from "./tags.js";

/** 面向调用方的记忆视图：只暴露产品需要的字段，屏蔽 hippo 内部列。 */
export interface MemoryHit {
  id: string;
  content: string;
  /** 用户可见标签（已剔除中文检索键）。 */
  tags: string[];
  /** 0~1，衰减后强度。 */
  strength: number;
  halfLifeDays: number;
  retrievalCount: number;
  createdAt: string;
  score: number;
  /** 类别（由 layer 推导）：fact=长期事实，lesson=经验。 */
  category: MemoryCategory;
  /** 原始记忆层（episodic/semantic），接口透传给前端。 */
  layer: string;
  /** 作用域：`workspace:<id>`，null = 全局。 */
  scope: string | null;
  /** 信任档：observed（机器观察）/ inferred（草稿，待转正）/ verified（已核实）。 */
  confidence: MemoryConfidence;
}

/**
 * 信任三档（上游 `confidence` 字段）：
 * - `observed`：机器直接观察到的（自动提炼的事实）；
 * - `inferred`：推断出来的草稿（自动提炼的经验），需被复用验证后转正；
 * - `verified`：已核实（用户明确要求记的、或草稿攒够确认次数晋升的）。
 * 只有 `verified` 免于「30 天没被检索就变 stale」的老化规则。
 */
export type MemoryConfidence = "observed" | "inferred" | "verified";

export interface RememberInput {
  content: string;
  tags?: string[];
  /** 作用域，如 `workspace:<id>`；缺省为全局。 */
  scope?: string;
  /** 工作空间 id：缺省 scope 时据此写 `workspace:<id>`。 */
  workspaceId?: string;
  /** 来源会话 id，用于溯源。 */
  sourceSessionId?: string;
  /** 来源工件 URI，如 `document://<id>`。 */
  artifactRef?: string;
  /** 类别（决定 layer）：事实=semantic，经验=episodic。默认 fact。 */
  category?: MemoryCategory;
  /** 信任档；缺省沿用上游默认 verified。自动提炼的条目必须显式降档。 */
  confidence?: MemoryConfidence;
}

export interface RecallInput {
  query: string;
  limit?: number;
  /** 精确作用域过滤（优先于 workspaceId）。 */
  scope?: string;
  /** 当前工作空间：检索「本空间 + 全局」，不传只看全局。 */
  workspaceId?: string;
  /** 只取某一类别。 */
  category?: MemoryCategory;
}

export interface HippoAdapterOptions {
  /** `.hippo` 库根目录（其下生成 hippo.db 与 markdown 镜像）。 */
  root: string;
  /** 记录在记忆行的 actor（审计用）。 */
  actor?: string;
  /** 租户键；单机产品恒为 local-user。 */
  tenantId?: string;
  logger?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
}

/** 记忆类别：fact=长期事实（偏好/决策/约束），lesson=经验（坑→方案）。 */
export type MemoryCategory = "fact" | "lesson";

/** 类别 → hippo 记忆层：事实沉淀为 semantic，经验保留 episodic 以保留时间性。 */
const CATEGORY_LAYER: Record<MemoryCategory, string> = { fact: "semantic", lesson: "episodic" };
const LAYER_CATEGORY: Record<string, MemoryCategory> = { semantic: "fact", episodic: "lesson" };

/** 工作空间作用域前缀：`workspace:<id>`；无前缀/空值视为全局。 */
const WORKSPACE_SCOPE_PREFIX = "workspace:";

export function workspaceScope(workspaceId: string): string {
  return `${WORKSPACE_SCOPE_PREFIX}${workspaceId}`;
}

export function isGlobalScope(scope: string | null | undefined): boolean {
  return scope == null || scope === "" || scope === "global";
}

const DEFAULT_ACTOR = "gateway";
const DEFAULT_TENANT = "local-user";
const DEFAULT_LIMIT = 5;
/**
 * 列表/检索的硬上限。曾经是 20——画像聚合扫来源、清理旧画像时都被这个上限截断
 * （来源看不全、旧画像删不掉），记忆一多就会攒出重复画像。放宽到 200：
 * 只有「读全量」的管理类调用会用到；检索侧调用方自己的 limit 仍是个位数量级。
 */
const MAX_LIMIT = 200;
/** 草稿转正门槛：被顺利复用这么多次，才认为它是可靠的。 */
const PROMOTION_THRESHOLD = 2;

/**
 * hippo-memory 的薄适配层。
 *
 * 设计约定：
 * - 只用库 API（`initStore`/`createMemory`/`writeEntry`/`search`/`applyOutcome`/`deleteEntry`），
 *   不启用 hippo 的 hooks 体系与 HTTP server。
 * - 中文检索键（cjk.ts 的转写）随写入追加进 tags，读取时统一剔除，
 *   因此调用方与 agent 只看到原始标签。
 * - 所有方法不抛异常给调用方：失败返回空结果并记录日志，避免记忆故障打断对话。
 */
export class HippoMemoryAdapter {
  private readonly root: string;
  private readonly actor: string;
  private readonly tenantId: string;
  private readonly logger: NonNullable<HippoAdapterOptions["logger"]>;
  private opened = false;

  constructor(options: HippoAdapterOptions) {
    this.root = options.root;
    this.actor = options.actor ?? DEFAULT_ACTOR;
    this.tenantId = options.tenantId ?? DEFAULT_TENANT;
    this.logger = options.logger ?? (() => {});
  }

  /** 打开（或创建）记忆库。幂等。 */
  open(): void {
    if (this.opened) return;
    initStore(this.root);
    this.opened = true;
  }

  isOpen(): boolean {
    return this.opened;
  }

  /** 写入一条记忆，返回行 id；失败返回 null。 */
  remember(input: RememberInput): string | null {
    const content = input.content.trim();
    if (content.length === 0) return null;
    try {
      this.ensureOpen();
      // 类别归一：标签里带「经验」即视为经验（层的选择与标签必须一致，
      // 否则整理回合合并后类别会漂移）。
      const wantsLesson = input.category === "lesson" || (input.tags ?? []).includes(LESSON_TAG);
      const rawTags = wantsLesson && !(input.tags ?? []).includes(LESSON_TAG)
        ? [...(input.tags ?? []), LESSON_TAG]
        : input.tags ?? [];
      const tags = this.withSearchKeys(content, rawTags);
      const category: MemoryCategory = wantsLesson ? "lesson" : "fact";
      const scope = input.scope !== undefined
        ? input.scope
        : input.workspaceId !== undefined && input.workspaceId !== ""
          ? workspaceScope(input.workspaceId)
          : undefined;
      const entry = createMemory(content, {
        tags,
        layer: CATEGORY_LAYER[category],
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(input.sourceSessionId !== undefined ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(input.artifactRef !== undefined ? { artifactRef: input.artifactRef } : {}),
      });
      writeEntry(this.root, entry, { actor: this.actor });
      this.logger("info", "memory.remember", { id: entry.id, scope: input.scope ?? null });
      return entry.id;
    } catch (error) {
      this.logger("error", "memory.remember.failed", { error: describe(error) });
      return null;
    }
  }

  /** BM25 检索；query 自动做中文转写。失败返回空数组。 */
  recall(input: RecallInput): MemoryHit[] {
    const query = input.query.trim();
    if (query.length === 0) return [];
    try {
      this.ensureOpen();
      const limit = clampLimit(input.limit);
      const entries = this.filterByScope(loadAllEntries(this.root), input);
      if (entries.length === 0) return [];
      const results = search(toHippoQuery(query), entries, { limit });
      return results
        .filter((result) => result.entry.kind !== "superseded")
        .slice(0, limit)
        .map((result) => toHit(result.entry, result.score));
    } catch (error) {
      this.logger("error", "memory.recall.failed", { error: describe(error) });
      return [];
    }
  }

  /** 结果反馈：标记某条记忆这次是否真的有用（hippo 的强化/衰减依据）。 */
  feedback(id: string, good: boolean): boolean {
    try {
      this.ensureOpen();
      const entry = readEntry(this.root, id);
      if (!entry) return false;
      writeEntry(this.root, applyOutcome(entry, good), { actor: this.actor });
      this.logger("info", "memory.feedback", { id, good });
      return true;
    } catch (error) {
      this.logger("error", "memory.feedback.failed", { error: describe(error), id });
      return false;
    }
  }

  /**
   * 检索回流：把这次真的被 agent 读到的条目标记为「被检索过」。
   *
   * hippo 的 `markRetrieved` 会 `retrieval_count+1`、把衰减锚点刷到当下、
   * 并给半衰期加分（`RETRIEVAL_HALF_LIFE_GAIN_DAYS`）——也就是说「用得上」的条目
   * 会自然活得久一点，「从没被用上」的条目在整理时先退场。
   * 返回真正更新的条数。
   */
  markUsed(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    try {
      this.ensureOpen();
      let updated = 0;
      for (const id of new Set(ids)) {
        const entry = readEntry(this.root, id);
        if (!entry || entry.kind === "superseded" || entry.superseded_by) continue;
        const [next] = markRetrieved([entry]);
        if (!next) continue;
        writeEntry(this.root, next, { actor: this.actor });
        updated += 1;
      }
      if (updated > 0) this.logger("info", "memory.mark_used", { count: updated });
      return updated;
    } catch (error) {
      this.logger("error", "memory.mark_used.failed", { error: describe(error) });
      return 0;
    }
  }

  /**
   * 隐性确认 + 自动转正（全程无人工）。
   *
   * 语义：这些条目在**一次顺利跑完**的会话里被检索到过（调用方已确认这次 run 没有
   * 工具失败/用户纠正），因此记一次正反馈；`inferred` 草稿攒够
   * `PROMOTION_THRESHOLD` 次正反馈就晋升为 `verified`（不再受 30 天老化影响）。
   */
  confirmUsage(ids: readonly string[]): { confirmed: number; promoted: number } {
    if (ids.length === 0) return { confirmed: 0, promoted: 0 };
    try {
      this.ensureOpen();
      let confirmed = 0;
      let promoted = 0;
      for (const id of new Set(ids)) {
        const entry = readEntry(this.root, id);
        if (!entry || entry.kind === "superseded" || entry.superseded_by) continue;
        const next = applyOutcome(entry, true);
        const positives = next.outcome_positive ?? 0;
        const canPromote = (next.confidence ?? "verified") === "inferred" && positives >= PROMOTION_THRESHOLD;
        const updated: HippoMemoryEntry = canPromote ? { ...next, confidence: "verified" } : next;
        writeEntry(this.root, updated, { actor: this.actor });
        confirmed += 1;
        if (canPromote) promoted += 1;
      }
      if (confirmed > 0) this.logger("info", "memory.confirm_usage", { confirmed, promoted });
      return { confirmed, promoted };
    } catch (error) {
      this.logger("error", "memory.confirm_usage.failed", { error: describe(error) });
      return { confirmed: 0, promoted: 0 };
    }
  }

  /**
   * 整理回合后的类别一致性检查（只统计、不改写）：
   * 带「经验」标签却不是 episodic 层的条目，说明它被 hippo 合并成了 semantic。
   * 读取侧已用「标签优先」兜住，这里只提供可观测数据。
   */
  categoryDrift(): { lessonTaggedNotEpisodic: number } {
    try {
      this.ensureOpen();
      const entries = loadAllEntries(this.root).filter((entry) => entry.kind !== "superseded");
      return {
        lessonTaggedNotEpisodic: entries.filter(
          (entry) => (entry.tags ?? []).includes(LESSON_TAG) && (entry.layer ?? "episodic") !== CATEGORY_LAYER.lesson,
        ).length,
      };
    } catch (error) {
      this.logger("error", "memory.category_drift.failed", { error: describe(error) });
      return { lessonTaggedNotEpisodic: 0 };
    }
  }

  /** 删除一条记忆。 */
  forget(id: string, reason?: string): boolean {
    try {
      this.ensureOpen();
      const deleted = deleteEntry(this.root, id, {
        actor: this.actor,
        ...(reason !== undefined ? { reason } : {}),
      });
      this.logger("info", "memory.forget", { id, deleted });
      return deleted;
    } catch (error) {
      this.logger("error", "memory.forget.failed", { error: describe(error), id });
      return false;
    }
  }

  /** 列出记忆（按创建时间倒序）。 */
  list(options: { limit?: number; scope?: string; workspaceId?: string; category?: MemoryCategory } = {}): MemoryHit[] {
    try {
      this.ensureOpen();
      const limit = clampLimit(options.limit, 50);
      return this.filterByScope(loadAllEntries(this.root), options)
        .filter((entry) => entry.kind !== "superseded")
        .sort((left, right) => right.created.localeCompare(left.created))
        .slice(0, limit)
        .map((entry) => toHit(entry, 0));
    } catch (error) {
      this.logger("error", "memory.list.failed", { error: describe(error) });
      return [];
    }
  }

  /** 简单统计，供健康检查/管理面板使用。 */
  stats(): { total: number; scopes: Record<string, number> } {
    try {
      this.ensureOpen();
      const entries = loadAllEntries(this.root);
      const scopes: Record<string, number> = {};
      for (const entry of entries) {
        const key = entry.scope ?? "(global)";
        scopes[key] = (scopes[key] ?? 0) + 1;
      }
      return { total: entries.length, scopes };
    } catch (error) {
      this.logger("error", "memory.stats.failed", { error: describe(error) });
      return { total: 0, scopes: {} };
    }
  }

  /**
   * 整理回合（hippo `sleep`）：衰减过期记忆、批量去重、情景合并成语义记忆、
   * 刷新冲突清单。`noShare` 关掉向全局库的复制（单租户产品不需要）。
   *
   * 不涉及任何网络：LLM 提取由库根 `config.json` 的 `extraction.enabled=false`
   * 关掉（见 MemoryService.open）。
   */
  async maintain(options: { dryRun?: boolean } = {}): Promise<HippoSleepResult> {
    this.ensureOpen();
    return sleep(this.context(), {
      noShare: true,
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    });
  }

  private context() {
    return {
      hippoRoot: this.root,
      tenantId: this.tenantId,
      actor: { subject: this.actor, role: "admin" as const, hostAdmin: true },
    };
  }

  /**
   * 作用域语义：
   * - 显式 `scope`：精确匹配；
   * - 传 `workspaceId`：本空间 + 全局（全局 = scope 为空/global）；
   * - 都不传：不过滤（内部调用与运维用）。
   * `category` 用「标签优先」判定（见 categoryOf），否则被 hippo 合并成 semantic 的经验会漏。
   */
  private filterByScope(
    entries: HippoMemoryEntry[],
    options: { scope?: string; workspaceId?: string; category?: MemoryCategory },
  ): HippoMemoryEntry[] {
    let filtered = entries;
    if (options.scope !== undefined) {
      filtered = filtered.filter((entry) => entry.scope === options.scope);
    } else if (options.workspaceId !== undefined && options.workspaceId !== "") {
      const own = workspaceScope(options.workspaceId);
      filtered = filtered.filter((entry) => entry.scope === own || isGlobalScope(entry.scope));
    }
    if (options.category !== undefined) {
      filtered = filtered.filter((entry) => categoryOf(entry) === options.category);
    }
    return filtered;
  }

  private ensureOpen(): void {
    if (!this.opened) this.open();
  }

  /**
   * 原始标签 + 中文检索键（去重）。
   * 只追加 `zh…` 转写键：ASCII 词在正文里已被原生分词命中，再把它们写进 tags
   * 只会在展示层泄漏出 `utf`、`pnpm` 这类噪声。
   */
  private withSearchKeys(content: string, tags: string[]): string[] {
    const merged = [...tags];
    if (needsSegmentation(content)) {
      for (const tag of tags) {
        if (needsSegmentation(tag)) merged.push(...searchKeys(tag).filter(isSearchKey));
      }
      merged.push(...searchKeys(content).filter(isSearchKey));
    }
    return dedupe(merged);
  }
}

/**
 * 行 → 类别：**标签优先，layer 兜底**。
 *
 * hippo 的整理回合会把聚集的 episodic 合并成一条 semantic（合并时标签取并集），
 * 只按 layer 判定会让经验在整理后变成事实。经验写入时强制带 LESSON_TAG，
 * 所以「有没有这个标签」比 layer 更稳定。
 */
function categoryOf(entry: HippoMemoryEntry): MemoryCategory {
  if ((entry.tags ?? []).includes(LESSON_TAG)) return "lesson";
  return LAYER_CATEGORY[entry.layer ?? "episodic"] ?? "lesson";
}

/** hippo 行 → 对外视图：剔除检索键标签，暴露展示字段。 */
function toHit(entry: HippoMemoryEntry, score: number): MemoryHit {
  return {
    id: entry.id,
    content: entry.content,
    tags: (entry.tags ?? []).filter((tag) => !isSearchKey(tag)),
    strength: entry.strength,
    halfLifeDays: entry.half_life_days,
    retrievalCount: entry.retrieval_count,
    createdAt: entry.created,
    score,
    category: categoryOf(entry),
    layer: entry.layer ?? "episodic",
    scope: entry.scope ?? null,
    confidence: (entry.confidence as MemoryConfidence | undefined) ?? "verified",
  };
}

function clampLimit(limit: number | undefined, fallback = DEFAULT_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
