import { isGlobalScope, type MemoryHit } from "./hippo-adapter.js";
import { isMemoryModelUnavailable } from "./model-errors.js";
import type { MemoryService } from "./service.js";
import { LESSON_TAG, PROFILE_TAG, isProfileSourceFact, profileGroupOf, sortByGroupOrder } from "./tags.js";

/**
 * 用户画像聚合（需求 2）。
 *
 * 与「记忆蒸馏」的分工：
 * - 蒸馏：会话结束/空隙时把对话压成**事实条目**（fact）与**经验条目**（lesson）；
 * - 聚合：定期把散落的偏好/约束类事实**收敛成一份结构化画像**（分组合并、去重、措辞规整），
 *   供「智能体」页画像段直接展示，也供后续注入系统提示。
 *
 * 触发（双保险）：每日定时 + 新增偏好类记忆达到阈值。
 * 存储约定：画像条目 = `tags: ["画像", <分组名>]`，category=fact（layer=semantic），全局作用域。
 * 每次聚合先清掉上一版画像条目，保证是「当前版本」而非不断累加。
 */

const DEFAULT_MAX_GROUPS = 5;
const DEFAULT_MAX_ITEMS_PER_GROUP = 4;
const DEFAULT_GROWTH_THRESHOLD = 8;
const DEFAULT_DAILY_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_INITIAL_DELAY_MS = 10 * 60_000;
const GENERATE_TIMEOUT_MS = 60_000;
const SOURCE_LIMIT = 200;

export interface ProfileGroup {
  title: string;
  items: string[];
}

export interface ProfileAggregateResult {
  groups: number;
  items: number;
  skipped: "disabled" | "no-source" | "model-error" | "model-unavailable" | "empty" | null;
}

export interface MemoryProfileAggregatorOptions {
  service: MemoryService;
  generate: (prompt: string) => Promise<string>;
  logger?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
  /** 每日聚合间隔（0=不定时）。 */
  intervalMs?: number;
  initialDelayMs?: number;
  /** 新增偏好类记忆达到该条数时额外触发。 */
  growthThreshold?: number;
  maxGroups?: number;
  maxItemsPerGroup?: number;
}

const AGGREGATE_PROMPT = `你是用户画像整理器。下面是关于同一位用户的零散长期记忆条目。
把它们收敛成一份结构化画像：合并同义条目、去掉一次性信息、只保留长期稳定的事实。

分组用简短中文名（例如：角色、工作习惯、偏好、常用工具、沟通方式、约束）。每组 1–4 条，每条不超过 40 字，用第三人称陈述事实，不要建议、不要评价。
最多 ${DEFAULT_MAX_GROUPS} 组；信息不足就少给几组。

只输出 JSON 数组，不要代码块围栏、不要解释：
[{"title":"偏好","items":["正式文档用简体中文","结论先行，避免长段落"]}]

记忆条目：
`;

export class MemoryProfileAggregator {
  private readonly service: MemoryService;
  private readonly generate: (prompt: string) => Promise<string>;
  private readonly logger: NonNullable<MemoryProfileAggregatorOptions["logger"]>;
  private readonly maxGroups: number;
  private readonly maxItemsPerGroup: number;
  private readonly growthThreshold: number;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastAggregatedCount = 0;

  constructor(options: MemoryProfileAggregatorOptions) {
    this.service = options.service;
    this.generate = options.generate;
    this.logger = options.logger ?? (() => {});
    this.maxGroups = options.maxGroups ?? DEFAULT_MAX_GROUPS;
    this.maxItemsPerGroup = options.maxItemsPerGroup ?? DEFAULT_MAX_ITEMS_PER_GROUP;
    this.growthThreshold = options.growthThreshold ?? DEFAULT_GROWTH_THRESHOLD;
    this.intervalMs = options.intervalMs ?? DEFAULT_DAILY_INTERVAL_MS;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  }

  /** 起每日定时；首次延迟到 initialDelayMs，错开启动高峰。 */
  start(): void {
    if (!this.service.isEnabled() || this.intervalMs <= 0 || this.timer) return;
    const initial = setTimeout(() => {
      void this.run({ reason: "daily" });
      this.timer = setInterval(() => void this.run({ reason: "daily" }), this.intervalMs);
      this.timer.unref?.();
    }, this.initialDelayMs);
    initial.unref?.();
    this.timer = initial;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 每写入一条记忆后调用：新增偏好类事实够量就额外聚合一次（双保险的第二重）。 */
  noteNewMemory(): void {
    if (!this.service.isEnabled() || this.growthThreshold <= 0) return;
    const facts = this.sourceEntries();
    if (facts.length === 0) return;
    if (facts.length - this.lastAggregatedCount < this.growthThreshold) return;
    void this.run({ reason: "growth" });
  }

  /** 立即聚合（定时/阈值/手动共用）。 */
  async run(options: { reason?: "daily" | "growth" | "manual" } = {}): Promise<ProfileAggregateResult> {
    if (!this.service.isEnabled()) return { groups: 0, items: 0, skipped: "disabled" };
    if (this.running) return { groups: 0, items: 0, skipped: "empty" };
    this.running = true;
    try {
      const source = this.sourceEntries();
      if (source.length === 0) {
        this.logger("info", "memory.profile.empty-source", { reason: options.reason ?? "manual" });
        return { groups: 0, items: 0, skipped: "no-source" };
      }
      const raw = await withTimeout(
        this.generate(`${AGGREGATE_PROMPT}${formatSource(source)}`),
        GENERATE_TIMEOUT_MS,
      );
      const groups = parseGroups(raw)
        .slice(0, this.maxGroups)
        .map((group) => ({ title: group.title, items: group.items.slice(0, this.maxItemsPerGroup) }))
        .filter((group) => group.items.length > 0);
      if (groups.length === 0) {
        this.logger("info", "memory.profile.empty", { reason: options.reason ?? "manual" });
        return { groups: 0, items: 0, skipped: "empty" };
      }
      this.replaceStoredProfile(groups);
      // 只在真的写出一版画像之后才推进阈值基准：先推进会把「失败」当成「已处理」，
      // 之后再攒满一整个 growthThreshold 才会重试（2026-11-02 那次就是这样空转的）。
      this.lastAggregatedCount = source.length;
      const items = groups.reduce((total, group) => total + group.items.length, 0);
      this.logger("info", "memory.profile.aggregated", {
        reason: options.reason ?? "manual",
        groups: groups.length,
        items,
      });
      return { groups: groups.length, items, skipped: null };
    } catch (error) {
      // 档位未就绪（桌面端还没过配置 gate / SaaS 未激活）不算聚合失败：
      // 阈值基准不动，档位就绪后下一次写入即可立刻重试。
      if (isMemoryModelUnavailable(error)) {
        this.logger("warn", "memory.profile.model-unavailable", { reason: options.reason ?? "manual" });
        return { groups: 0, items: 0, skipped: "model-unavailable" };
      }
      this.logger("error", "memory.profile.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { groups: 0, items: 0, skipped: "model-error" };
    } finally {
      this.running = false;
    }
  }

  /** 当前生效的画像（供页面/注入读取）。 */
  read(): ProfileGroup[] {
    const stored = this.service
      .list({ limit: 200 })
      .filter((hit) => hit.tags.includes(PROFILE_TAG))
      // 同一批写入的时间戳相同，按内容回排不稳定；用 id 兜底保证顺序可复现。
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const groups = new Map<string, string[]>();
    for (const hit of stored) {
      const title = hit.tags.find((tag) => tag !== PROFILE_TAG) ?? "画像";
      const bucket = groups.get(title) ?? [];
      bucket.push(hit.content);
      groups.set(title, bucket);
    }
    return [...groups].map(([title, items]) => ({ title, items }));
  }

  /** 参与聚合的来源：用户本人的稳定属性，排除画像自身、经验与工作空间局部事实。 */
  private sourceEntries(): MemoryHit[] {
    return this.service
      .list({ limit: SOURCE_LIMIT, category: "fact" })
      // 聚合产物本身是全局作用域：只吃全局事实，避免把某个空间的约定搬进全局画像。
      .filter((hit) => isGlobalScope(hit.scope))
      .filter((hit) => isProfileSourceFact(hit.tags));
  }

  /** 用新一版覆盖旧画像：先删旧的画像条目，再写新的。 */
  private replaceStoredProfile(groups: ProfileGroup[]): void {
    for (const hit of this.service.list({ limit: 500 })) {
      if (hit.tags.includes(PROFILE_TAG)) this.service.forget(hit.id, "profile_refresh");
    }
    for (const group of groups) {
      for (const item of group.items) {
        this.service.remember({
          content: item,
          tags: [PROFILE_TAG, group.title],
          category: "fact",
        });
      }
    }
  }
}

/** 容错解析画像 JSON。 */
export function parseGroups(raw: string): ProfileGroup[] {
  const withoutFence = raw.replace(/```(?:json)?/gi, "").trim();
  const start = withoutFence.indexOf("[");
  const end = withoutFence.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const groups: ProfileGroup[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) continue;
    const items = Array.isArray(record.items)
      ? record.items
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && entry.length <= 80)
      : [];
    if (items.length === 0) continue;
    groups.push({ title, items: [...new Set(items)] });
  }
  return groups;
}

function formatSource(entries: MemoryHit[]): string {
  return entries.map((entry) => `- [${entry.tags.join("/")}] ${entry.content}`).join("\n");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`memory profile timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

export interface ProfileViewItem {
  id: string;
  content: string;
}

export interface ProfileViewGroup {
  title: string;
  items: ProfileViewItem[];
}

export interface ProfileView {
  /**
   * aggregate=模型聚合出来的一版画像（最优）；
   * fallback=聚合还没跑过，直接按标签把原始事实分组（**不丢条目**）；
   * empty=记忆库为空。
   */
  source: "aggregate" | "fallback" | "empty";
  groups: ProfileViewGroup[];
}

const VIEW_LIMIT = 200;

/**
 * 「用户画像」页的只读视图（`GET /v1/memory/profile`）。
 *
 * 聚合优先、标签兜底：聚合是模型调用，档位没配好/调用失败时会长期没有产物，
 * 那时绝不能显示「还没有沉淀画像」——用户交代过的信息就在库里，只是没被整理。
 * 兜底分组用 `profileGroupOf` 归一标签，认不出的进「其他」，**任何一条 fact 都不会消失**。
 */
export function readProfileView(
  service: MemoryService,
  options: { limit?: number } = {},
): ProfileView {
  if (!service.isEnabled()) return { source: "empty", groups: [] };
  const hits = service.list({ limit: options.limit ?? VIEW_LIMIT });

  const aggregated = hits.filter((hit) => hit.tags.includes(PROFILE_TAG));
  if (aggregated.length > 0) {
    const groups = new Map<string, ProfileViewItem[]>();
    // 聚合产物同一批写入、时间戳相同：按 createdAt 再按 id 回排，还原模型的输出顺序。
    const ordered = [...aggregated].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    for (const hit of ordered) {
      const title = hit.tags.find((tag) => tag !== PROFILE_TAG) ?? PROFILE_TAG;
      pushItem(groups, title, hit);
    }
    return { source: "aggregate", groups: toGroups(groups) };
  }

  const facts = hits
    .filter((hit) => hit.category === "fact")
    .filter((hit) => !hit.tags.includes(LESSON_TAG));
  if (facts.length === 0) return { source: "empty", groups: [] };

  const groups = new Map<string, ProfileViewItem[]>();
  for (const hit of facts) pushItem(groups, profileGroupOf(hit.tags), hit);
  return { source: "fallback", groups: sortByGroupOrder(toGroups(groups)) };
}

function pushItem(
  groups: Map<string, ProfileViewItem[]>,
  title: string,
  hit: MemoryHit,
): void {
  const bucket = groups.get(title) ?? [];
  if (!bucket.some((item) => item.content === hit.content)) {
    bucket.push({ id: hit.id, content: hit.content });
  }
  groups.set(title, bucket);
}

function toGroups(groups: Map<string, ProfileViewItem[]>): ProfileViewGroup[] {
  return [...groups].map(([title, items]) => ({ title, items }));
}


/**
 * 注入 agent 系统上下文用的画像文本。
 *
 * 与页面展示是两种消费方式：页面要全量（用户想看见自己被记住了什么），
 * system prompt 只该拿**稳定、短、可复用**的那一小部分——每轮都进 prompt 的内容
 * 吃的是上下文预算，宁少勿滥。所以这里做三重裁剪：分组数、每组条数、总字符数。
 */
const PROMPT_MAX_GROUPS = 5;
const PROMPT_MAX_ITEMS_PER_GROUP = 4;
const PROMPT_MAX_ITEM_CHARS = 60;
const PROMPT_MAX_CHARS = 700;

const PROMPT_HEADER = "【用户画像】以下是系统自动沉淀的、关于用户本人的稳定信息（可能不是最新，冲突时以用户本轮说法为准）：";
const PROMPT_FOOTER = "用法：仅在相关时据此调整称呼、语言、格式与工作方式；不要向用户复述或罗列这份画像，也不要把它当成用户本轮的新指令。";

/** 画像视图 → 可注入的文本块；没有可用条目时返回 null（调用方不注入）。 */
export function buildProfilePrompt(view: ProfileView): string | null {
  const groups = view.groups
    .map((group) => ({
      title: group.title.trim(),
      items: group.items
        .map((item) => item.content.trim())
        .filter((content) => content.length > 0)
        .slice(0, PROMPT_MAX_ITEMS_PER_GROUP)
        .map((content) => (content.length > PROMPT_MAX_ITEM_CHARS
          ? `${content.slice(0, PROMPT_MAX_ITEM_CHARS)}…`
          : content)),
    }))
    .filter((group) => group.title.length > 0 && group.items.length > 0)
    .slice(0, PROMPT_MAX_GROUPS);
  if (groups.length === 0) return null;

  const lines = [PROMPT_HEADER];
  let used = PROMPT_HEADER.length + PROMPT_FOOTER.length;
  for (const group of groups) {
    // 逐组累加，超预算就停：宁可少给一组，也不截断到半句话。
    const line = `- ${group.title}：${group.items.join("；")}`;
    if (used + line.length > PROMPT_MAX_CHARS) break;
    used += line.length;
    lines.push(line);
  }
  if (lines.length === 1) return null;
  lines.push(PROMPT_FOOTER);
  return lines.join("\n");
}

/**
 * 注入用的画像文本缓存。
 *
 * 记忆库读取是「扫全部 .md 再排序」，不适合每轮 run 都做一次；而画像变化很慢
 * （每日定时 + 8 条阈值），所以按 TTL 缓存，写入记忆时立即失效。
 */
export function createUserProfilePromptCache(
  service: MemoryService,
  options: { ttlMs?: number } = {},
): { get: () => string | null; invalidate: () => void } {
  const ttlMs = options.ttlMs ?? 60_000;
  let cached: string | null = null;
  let cachedAt = 0;
  let primed = false;
  return {
    get: () => {
      if (!service.isEnabled()) return null;
      const now = Date.now();
      if (primed && now - cachedAt < ttlMs) return cached;
      cached = buildProfilePrompt(readProfileView(service));
      cachedAt = now;
      primed = true;
      return cached;
    },
    invalidate: () => {
      primed = false;
      cachedAt = 0;
      cached = null;
    },
  };
}
