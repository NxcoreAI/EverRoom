/**
 * hippo-memory 类型垫片。
 *
 * 上游 2.2.0 的 package.json 没有 `types` 字段、exports 也没有 types 条件
 * （虽然 dist/ 里有 .d.ts），因此 TypeScript 无法自动解析类型。
 * 这里只声明本仓库实际用到的表面，签名对照 dist/*.d.ts 与运行时实测。
 */
declare module "hippo-memory" {
  /** 一条记忆行（envelope 见上游 MEMORY_ENVELOPE.md）。 */
  export interface HippoMemoryEntry {
    id: string;
    content: string;
    tags: string[];
    /** 衰减后强度，0~1。 */
    strength: number;
    half_life_days: number;
    retrieval_count: number;
    created: string;
    last_retrieved?: string | null;
    scope?: string | null;
    owner?: string | null;
    source_session_id?: string | null;
    kind?: string;
    /** 记忆层：buffer | episodic | semantic | trace。 */
    layer?: string;
    confidence?: string;
    superseded_by?: string | null;
    /** 正/负反馈计数（`applyOutcome` 累加，转正门槛据此判定）。 */
    outcome_positive?: number;
    outcome_negative?: number;
    /** 来源工件（如 `document://<id>`），用于溯源「依据哪份文件」。 */
    artifact_ref?: string | null;
    /** 由哪些父条目合并而来（整理回合产出的语义条目会带）。 */
    parents?: string[];
  }

  /** BM25 检索结果。`search(query, entries, options?)` 的返回元素。 */
  export interface HippoSearchResult {
    entry: HippoMemoryEntry;
    score: number;
    bm25: number;
  }

  export interface CreateMemoryOptions {
    tags?: string[];
    /** 记忆层（经验=episodic，长期事实=semantic）。 */
    layer?: string;
    scope?: string;
    owner?: string;
    sourceSessionId?: string;
    artifactRef?: string;
    confidence?: string;
  }

  export interface SearchOptions {
    limit?: number;
    /** 输出预算（token），缺省 4000。 */
    budget?: number;
    includeSuperseded?: boolean;
  }

  /** 建库/升级 schema；幂等，已初始化时只做迁移检查。 */
  export function initStore(hippoRoot: string): void;
  export function closeHippoDb(): void;

  export function createMemory(content: string, options?: CreateMemoryOptions): HippoMemoryEntry;
  export function writeEntry(hippoRoot: string, entry: HippoMemoryEntry, opts?: { actor?: string }): void;
  export function loadAllEntries(hippoRoot: string, tenantId?: string): HippoMemoryEntry[];
  export function readEntry(hippoRoot: string, id: string, tenantId?: string): HippoMemoryEntry | null;
  export function deleteEntry(
    hippoRoot: string,
    id: string,
    opts?: { actor?: string; reason?: string },
  ): boolean;
  /** 返回应用结果反馈后的新行（不落库，需配合 writeEntry 持久化）。 */
  export function applyOutcome(entry: HippoMemoryEntry, good: boolean): HippoMemoryEntry;
  /** 返回标记"被检索过"后的新行（不落库）。 */
  export function markRetrieved(entries: HippoMemoryEntry[]): HippoMemoryEntry[];
  export function search(
    query: string,
    entries: HippoMemoryEntry[],
    options?: SearchOptions,
  ): HippoSearchResult[];

  /** 调用上下文（租户与审计主体）。 */
  export interface HippoContext {
    hippoRoot: string;
    tenantId: string;
    actor: { subject: string; role: "admin" | "member"; hostAdmin?: boolean; owner?: string };
  }

  export interface HippoSleepOptions {
    /** 只报告改动不落库。 */
    dryRun?: boolean;
    /** 跳过把高分记忆复制到全局库（单租户产品应传 true）。 */
    noShare?: boolean;
  }

  export interface HippoSleepResult {
    active: number;
    removed: number;
    dormant?: number;
    mergedEpisodic: number;
    newSemantic: number;
    dryRun: boolean;
    deduped?: { removed: number; semDups: number; epiDups: number; crossDups: number };
    [key: string]: unknown;
  }

  /** 整理回合：衰减 / 去重 / 情景合并 / 冲突刷新。不启用 LLM 提取时全程本地。 */
  export function sleep(ctx: HippoContext, opts?: HippoSleepOptions): Promise<HippoSleepResult>;
}
