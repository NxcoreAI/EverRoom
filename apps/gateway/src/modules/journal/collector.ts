import { createHash } from "node:crypto";

import type { MemoryHit } from "../memory/hippo-adapter.js";
import { dateInTimezone, zonedTimeToUtc } from "../../infrastructure/time/zone-time.js";
import type { JournalSignal, JournalSnapshot } from "./types.js";

/**
 * 每日洞察的信号采集（一期：只接长期记忆）。
 *
 * ## 为什么只接记忆
 *
 * 记忆条目是「用户告诉过我什么 / 我学到了什么」——它本来就经过一次提炼（会话蒸馏），
 * 信息密度高、噪声低，且天然带「今天新写」的时间戳。文件与会话属于"工作痕迹"，
 * 混进来会让卡片在「我记住的你」和「你今天动了什么」之间摇摆；等记忆这条链路稳定后
 * 再按 `JournalSignalKind` 扩类，而不是一开始就四路并列。
 *
 * ## 日界
 *
 * 用本地时区切日（`dateInTimezone` / `zonedTimeToUtc`），**不做 UTC 截断**——
 * 否则 23:30 之后写下的记忆会掉进"明天"，早上打开应用时看到的是空日记。
 */

/** 一次最多拉多少条记忆参与筛选（与 `/v1/memory/entries` 上限对齐）。 */
const LIST_LIMIT = 200;
/** 进 prompt 的信号上限（聚类之后）。再多模型也只会挑前几条，纯烧 token。 */
const MAX_SIGNALS = 6;
/** 摘要正文上限。 */
const EXCERPT_LIMIT = 160;
/** 标题上限。 */
const TITLE_LIMIT = 48;
/** 同簇判定：标签 Jaccard 阈值。 */
const CLUSTER_JACCARD = 0.3;
/** 半衰期短于该值的条目按"快忘了"打折——今天写的但已经很弱的条目不该占版面。 */
const WEAK_STRENGTH = 0.5;

export interface JournalCollectorOptions {
  /** 记忆条目读取（`MemoryService.list`；跨空间合并）。 */
  list: () => MemoryHit[];
  /** 当前时区（IANA）。桌面端与网关同机，取系统时区即可。 */
  timezone: () => string;
  now?: () => Date;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** 当天 [00:00, 次日 00:00) 的绝对时间窗。 */
export function dayWindow(date: string, timezone: string): { start: Date; end: Date } {
  const start = zonedTimeToUtc(date, "00:00", timezone);
  // 用「次日」的本地日期再算一次零点，而不是 start + 24h：夏令时切换日不是 24 小时，
  // 固定加 24h 会把日界挪偏一小时（表现为跨夏令时的日记里多/少一小时的内容）。
  const probe = new Date(start.getTime() + 24 * 60 * 60_000);
  const nextDate = dateInTimezone(probe, timezone);
  return { start, end: zonedTimeToUtc(nextDate, "00:00", timezone) };
}

/** 标签 Jaccard（两边都没标签时不算相似：宁可不合并，也别把不相干的事捆一起）。 */
function jaccard(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let shared = 0;
  for (const tag of a) if (b.has(tag)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * 单条记忆的权重。
 *
 * `weight = 类别基线 × 新近度 + 置信档修正 + 强度修正`（最终夹到 0.05..1）：
 * - 类别基线：经验 1.0 > 事实 0.9 —— 经验是"踩过的坑"，对用户行动更有用；
 * - 新近度：0.6 → 1.0 线性，越靠近当下越重要；
 * - 置信档：verified +0.1 / observed 0 / inferred −0.2 —— 推断出来的草稿不该抢版面；
 * - 强度：< 0.5 扣 0.1（衰减得快 ≈ 系统自己也不确定）。
 */
export function memorySignalWeight(
  hit: Pick<MemoryHit, "category" | "confidence" | "strength">,
  at: Date,
  window: { start: Date; end: Date },
): number {
  const base = hit.category === "lesson" ? 1 : 0.9;
  const span = Math.max(1, window.end.getTime() - window.start.getTime());
  const progress = clamp((at.getTime() - window.start.getTime()) / span, 0, 1);
  const recency = 0.6 + 0.4 * progress;
  const confidenceDelta =
    hit.confidence === "verified" ? 0.1 : hit.confidence === "inferred" ? -0.2 : 0;
  const strengthDelta = hit.strength < WEAK_STRENGTH ? -0.1 : 0;
  return clamp(base * recency + confidenceDelta + strengthDelta, 0.05, 1);
}

/** 证据指纹：只认「哪些条目」，不认权重（权重大小不改变内容，没必要触发重写）。 */
export function fingerprintOf(date: string, ids: readonly string[]): string {
  const stable = [...ids].sort();
  return createHash("sha256").update(`${date}\n${stable.join("\n")}`).digest("hex").slice(0, 32);
}

/**
 * 采集当天信号。
 *
 * 两步：**按时间过滤** → **按标签聚类**（同一件事的 3 条记忆合成 1 条，
 * 否则一整张卡都被同一件事占满）。
 */
export function collectJournalSignals(options: JournalCollectorOptions): JournalSnapshot {
  const now = options.now?.() ?? new Date();
  const timezone = options.timezone();
  const date = dateInTimezone(now, timezone);
  const window = dayWindow(date, timezone);

  const todays = options.list()
    .map((hit) => ({ hit, at: new Date(hit.createdAt) }))
    .filter((row) => Number.isFinite(row.at.getTime()))
    .filter((row) => row.at.getTime() >= window.start.getTime() && row.at.getTime() < window.end.getTime())
    .map((row) => ({
      hit: row.hit,
      at: row.at,
      weight: memorySignalWeight(row.hit, row.at, window),
    }))
    .sort((left, right) => right.weight - left.weight);

  const clusters: Array<{ signal: JournalSignal; tags: string[] }> = [];
  for (const row of todays) {
    const tags = row.hit.tags ?? [];
    const target = clusters.find((cluster) => jaccard(cluster.tags, tags) >= CLUSTER_JACCARD);
    if (target) {
      // 代表条目取权重最高的那条（已按权重降序），其余只记计数——不重复进 prompt。
      target.signal.merged += 1;
      target.tags = [...new Set([...target.tags, ...tags])];
      continue;
    }
    clusters.push({
      tags,
      signal: {
        id: `memory:${row.hit.id}`,
        kind: "memory",
        at: row.at.toISOString(),
        title: truncate(row.hit.content, TITLE_LIMIT),
        excerpt: truncate(row.hit.content, EXCERPT_LIMIT),
        weight: Number(row.weight.toFixed(3)),
        merged: 0,
        ...(row.hit.category === "fact" || row.hit.category === "lesson" ? { category: row.hit.category } : {}),
        ...(row.hit.confidence ? { confidence: row.hit.confidence } : {}),
      },
    });
  }

  const signals = clusters.slice(0, MAX_SIGNALS).map((cluster) => cluster.signal);
  return {
    date,
    signals,
    signalCount: todays.length,
    fingerprint: fingerprintOf(date, todays.map((row) => `memory:${row.hit.id}`)),
  };
}
