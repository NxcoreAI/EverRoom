import { createHash } from "node:crypto";
import type { SlidesProgressPage } from "./slides-draft-doc.js";
import type { ContentSource } from "./slides-semantic-contract.js";

/**
 * arrange 分批：把「整册一次成稿」拆成可独立失败/重试/复用的小批次。
 *
 * 背景（2026-10-22 实测）：27 页 deck 的 8 次 arrange 全败——5 次 420s 超时、
 * 2 次 40 次工具上限、1 次重启中断。根因不是预算数字，而是**工作单位**：
 * 生成、失败、重试、持久化都以整册为单位，任何一页出问题整册作废，页数越多
 * 单次调用的上下文/输出/思考越重。这里把单位改成 6~8 页一批：
 * - 每批是独立的 planner 调用，单批失败只重试该批；
 * - 批次结果在网关合并（页序/页 ID/来源由确定性校验守住，不靠模型记全册）；
 * - 合并后的整册仍走原有 semantic-v3 全局校验与修复（assembleSemanticPlan）。
 *
 * 本模块只做确定性计算：切批、批次元信息、批结果校验、合并、checkpoint key。
 * 调度/重试/检查点在 tools.ts 里接线。
 */

export interface ArrangeBatch {
  /** 0 起批次序号。 */
  index: number;
  total: number;
  /** 0 起全册页序号。 */
  startPageIndex: number;
  pageCount: number;
  pages: SlidesProgressPage[];
  sources: ContentSource[];
}

export interface ArrangeBatchMeta {
  index: number;
  total: number;
  startPageIndex: number;
  pageCount: number;
  /** 全册标题：模型输出 title 要沿用它，合并时以它为准。 */
  deckTitle: string;
  /** 前两页标题，给本批开场做承接；没有则为空。 */
  previousPageTitles: string[];
  /** 下一页标题，给本批收尾做承接；末批没有。 */
  nextPageTitle?: string;
}

export interface ArrangeBatchFailure {
  batch: ArrangeBatch;
  status: string;
  errorCode: string;
  /** 失败详情（如语义契约的具体缺陷），用于用户可见提示与重试注入。 */
  errorMessage?: string;
  invocationId?: string;
}

const MAX_BATCH_PAGES = 32;
const MIN_BATCH_SIZE = 4;
const MAX_BATCH_SIZE = 12;

/** 页 ID 顺序与 assembleSemanticPlan 同口径：来源首次出现的顺序即页序。 */
export function arrangePageIds(sources: ContentSource[]): string[] {
  return [...new Set(sources.map((source) => source.pageId))];
}

/**
 * 按页切批。批数与批大小同时受控：先定批数再均分，避免最后一批只剩 1 页。
 * 例：27 页、batchSize=8 → 4 批（7/7/7/6）；9 页 → 2 批（5/4）。
 */
export function planArrangeBatches(input: {
  pages: SlidesProgressPage[];
  sources: ContentSource[];
  batchSize?: number;
}): ArrangeBatch[] {
  const pages = input.pages.slice(0, MAX_BATCH_PAGES);
  if (pages.length === 0) return [];
  const requested = Math.trunc(input.batchSize ?? 8);
  const batchSize = Math.min(Math.max(requested, MIN_BATCH_SIZE), MAX_BATCH_SIZE);
  const total = Math.max(1, Math.ceil(pages.length / batchSize));
  const size = Math.ceil(pages.length / total);
  const pageIds = arrangePageIds(input.sources);
  const byPageId = new Map<string, ContentSource[]>();
  for (const source of input.sources) {
    const list = byPageId.get(source.pageId) ?? [];
    list.push(source);
    byPageId.set(source.pageId, list);
  }
  const batches: ArrangeBatch[] = [];
  for (let index = 0; index < total; index += 1) {
    const start = index * size;
    const end = Math.min(pages.length, start + size);
    const batchPages = pages.slice(start, end);
    const sources = batchPages.flatMap((_page, offset) => byPageId.get(pageIds[start + offset] ?? "") ?? []);
    batches.push({
      index,
      total,
      startPageIndex: start,
      pageCount: batchPages.length,
      pages: batchPages,
      sources,
    });
  }
  return batches;
}

export function arrangeBatchMeta(
  batch: ArrangeBatch,
  pages: SlidesProgressPage[],
  deckTitle: string,
): ArrangeBatchMeta {
  const previousPageTitles = pages
    .slice(Math.max(0, batch.startPageIndex - 2), batch.startPageIndex)
    .map((page) => String(page.title ?? "").trim())
    .filter(Boolean);
  const nextTitle = String(pages[batch.startPageIndex + batch.pageCount]?.title ?? "").trim();
  return {
    index: batch.index,
    total: batch.total,
    startPageIndex: batch.startPageIndex,
    pageCount: batch.pageCount,
    deckTitle: deckTitle.slice(0, 120),
    previousPageTitles,
    ...(nextTitle ? { nextPageTitle: nextTitle.slice(0, 80) } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sourceRefsOf(content: Record<string, unknown>): unknown[] {
  const refs: unknown[] = [
    ...(Array.isArray(content.sourceRefs) ? content.sourceRefs : []),
    ...(Array.isArray(content.blocks)
      ? content.blocks.flatMap((block) => {
          const record = asRecord(block);
          return record && Array.isArray(record.sourceRefs) ? record.sourceRefs : [];
        })
      : []),
    ...(asRecord(content.constraints) && Array.isArray((content.constraints as Record<string, unknown>).verbatimRefs)
      ? (content.constraints as Record<string, unknown>).verbatimRefs as unknown[]
      : []),
    ...(Array.isArray(content.omissions)
      ? content.omissions.flatMap((omission) => {
          const record = asRecord(omission);
          return record && typeof record.sourceRef === "string" ? [record.sourceRef] : [];
        })
      : []),
  ];
  return refs;
}

/**
 * 批结果确定性校验：页数、页标题、语义 content、来源归属。
 * 返回空数组 = 可合并；非空 = 该批重试（错误会进日志/重试原因，不送模型）。
 */
export function validateArrangeBatchPlan(batch: ArrangeBatch, value: unknown): string[] {
  const plan = asRecord(value);
  if (!plan) return ["批结果不是对象"];
  const pages = plan.pages;
  if (!Array.isArray(pages)) return ["pages 缺失"];
  if (pages.length !== batch.pageCount) return [`页数不符（${pages.length}/${batch.pageCount}）`];
  const pageIds = arrangePageIds(batch.sources);
  const knownPageIds = new Set(pageIds);
  const owners = new Map(batch.sources.map((source) => [source.id, source.pageId]));
  const errors: string[] = [];
  pages.forEach((raw, index) => {
    const page = asRecord(raw);
    const expected = pageIds[index];
    if (!page) {
      errors.push(`第 ${index + 1} 页不是对象`);
      return;
    }
    if (typeof page.title !== "string" || !page.title.trim()) errors.push(`第 ${index + 1} 页缺标题`);
    const content = asRecord(page.content);
    if (!content) {
      errors.push(`第 ${index + 1} 页缺语义 content`);
      return;
    }
    const id = content.id;
    if (typeof id !== "string" || !id.trim()) errors.push(`第 ${index + 1} 页 content.id 缺失`);
    else if (expected && id !== expected && knownPageIds.has(id)) {
      errors.push(`第 ${index + 1} 页占用了其他页的 ID（${id}）`);
    }
    const sourceRefs = Array.isArray(content.sourceRefs) ? content.sourceRefs : [];
    if (sourceRefs.length === 0) errors.push(`第 ${index + 1} 页 content.sourceRefs 为空`);
    if (sourceRefs.some((ref) => typeof ref !== "string" || owners.get(ref) !== expected)) {
      errors.push(`第 ${index + 1} 页来源不属于本页`);
    }
    if (!Array.isArray(content.blocks) || content.blocks.length === 0) errors.push(`第 ${index + 1} 页 content.blocks 为空`);
  });
  return errors;
}

function uniqueStrings(values: unknown[], maximum: number, length: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text.slice(0, length));
    if (result.length >= maximum) break;
  }
  return result;
}

/**
 * 合并分批结果：页按全册序拼接；title 用确认稿标题；narrative/warnings/summary
 * 确定性拼接（去重限长）。content.id 若被模型写错但来源全部指向本页，按来源
 * 规范化（与 assembleSemanticPlan 的既有规则一致），不把这类小错升级成整册失败。
 */
export function mergeArrangeBatchPlans(input: {
  deckTitle: string;
  pages: SlidesProgressPage[];
  sources: ContentSource[];
  batches: ArrangeBatch[];
  results: Map<number, Record<string, unknown>>;
}): { plan: Record<string, unknown>; warnings: string[] } {
  const ordered = [...input.batches].sort((left, right) => left.index - right.index);
  const mergedPages: Array<Record<string, unknown>> = [];
  for (const batch of ordered) {
    const plan = input.results.get(batch.index);
    if (!plan) throw new Error(`arrange_batch_missing:${batch.index}`);
    const pages = Array.isArray(plan.pages) ? plan.pages : [];
    for (const page of pages) mergedPages.push(asRecord(page) ?? {});
  }
  if (mergedPages.length !== input.pages.length) {
    throw new Error(`arrange_batch_page_count:${mergedPages.length}/${input.pages.length}`);
  }

  const pageIds = arrangePageIds(input.sources);
  const owners = new Map(input.sources.map((source) => [source.id, source.pageId]));
  const identityWarnings: string[] = [];
  mergedPages.forEach((page, index) => {
    const expected = pageIds[index];
    const content = asRecord(page.content);
    if (!expected || !content || content.id === expected) return;
    const refs = sourceRefsOf(content);
    if (refs.length === 0) return;
    if (refs.some((ref) => typeof ref !== "string" || owners.get(ref) !== expected)) return;
    content.id = expected;
    identityWarnings.push(`第 ${index + 1} 页: 已按确认来源规范页面 ID`);
  });

  const firstPlan = ordered[0] ? input.results.get(ordered[0].index) : undefined;
  const fallbackTitle = typeof firstPlan?.title === "string" ? firstPlan.title : "";
  const deckTitle = input.deckTitle.trim() || fallbackTitle.trim() || "演示文稿";
  const narrative = uniqueStrings(
    ordered.map((batch) => input.results.get(batch.index)?.narrative),
    4, 500,
  ).join("；").slice(0, 500);
  const warnings = uniqueStrings([
    ...ordered.flatMap((batch) => {
      const value = input.results.get(batch.index)?.warnings;
      return Array.isArray(value) ? value : [];
    }),
    ...identityWarnings,
  ], 12, 300);
  const summary = uniqueStrings(
    ordered.map((batch) => input.results.get(batch.index)?.summary),
    6, 1000,
  ).join("；").slice(0, 1000);
  return {
    plan: {
      phase: "arrange",
      title: deckTitle.slice(0, 120),
      ...(narrative ? { narrative } : {}),
      pages: mergedPages,
      ...(warnings.length ? { warnings } : {}),
      ...(summary ? { summary } : {}),
    },
    warnings,
  };
}

/** checkpoint key：草稿/指令/风格/来源任一变化都必须是新的编排，不能复用旧批次。 */
export function arrangeBatchCheckpointKey(fingerprint: {
  draftDocumentId: string;
  instruction: string;
  sourcesHash: string;
  deckStyle?: unknown;
  referenceStyle?: unknown;
  batchSize: number;
  generation?: unknown;
}): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
    }
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(stable({
      draftDocumentId: fingerprint.draftDocumentId,
      instruction: fingerprint.instruction,
      sourcesHash: fingerprint.sourcesHash,
      deckStyle: fingerprint.deckStyle ?? null,
      referenceStyle: fingerprint.referenceStyle ?? null,
      batchSize: fingerprint.batchSize,
      generation: fingerprint.generation ?? null,
    })))
    .digest("hex");
}

export interface ArrangeBatchRunResult {
  ok: true;
  plan: Record<string, unknown>;
  invocationId?: string;
}

export interface ArrangeBatchRunError {
  ok: false;
  status: string;
  errorCode: string;
  invocationId?: string;
  /** 失败详情（如语义契约的具体缺陷），用于用户可见提示与重试注入。 */
  errorMessage?: string;
  /**
   * 是否值得整批重跑。确定性失败（如 semantic-v3 内容契约校验不过）设 false：
   * 同样的确认稿与模型再排一次只会复现同类错误，重试纯属空转。
   */
  retryable?: boolean;
}

export interface ArrangeBatchesOutcome {
  results: Map<number, Record<string, unknown>>;
  failures: ArrangeBatchFailure[];
  /** 第一条成功批次的 invocation id：落页调用链挂靠它便于时间线展示。 */
  firstInvocationId: string | null;
  reused: number;
  aborted: boolean;
}

/**
 * 并发跑批次：已 checkpoint 的批次直接复用；失败批次有限重试（取消/中断不重试）。
 * 单批失败不打断其他批——已完成结果留在 results 里，调用方据此保留 checkpoint。
 */
export async function runArrangeBatches(input: {
  batches: ArrangeBatch[];
  checkpoint?: Map<number, Record<string, unknown>>;
  run(batch: ArrangeBatch, attempt: number): Promise<ArrangeBatchRunResult | ArrangeBatchRunError>;
  onBatchDone?(batch: ArrangeBatch, plan: Record<string, unknown>): void;
  signal?: AbortSignal;
  concurrency?: number;
  attempts?: number;
}): Promise<ArrangeBatchesOutcome> {
  // 直接复用调用方的 checkpoint Map：成功批要写回，跨用户重试才能跳过。
  const results = input.checkpoint ?? new Map<number, Record<string, unknown>>();
  const reused = results.size;
  const pending = input.batches.filter((batch) => !results.has(batch.index));
  const failures: ArrangeBatchFailure[] = [];
  let firstInvocationId: string | null = null;
  let cursor = 0;
  const attempts = Math.max(1, input.attempts ?? 2);
  const workerCount = Math.min(Math.max(1, input.concurrency ?? 2), Math.max(1, pending.length));
  const workers = Array.from({ length: pending.length === 0 ? 0 : workerCount }, async () => {
    for (;;) {
      if (input.signal?.aborted) return;
      const batch = pending[cursor];
      cursor += 1;
      if (!batch) return;
      let failure: ArrangeBatchFailure | null = null;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (input.signal?.aborted) return;
        let outcome: ArrangeBatchRunResult | ArrangeBatchRunError;
        try {
          outcome = await input.run(batch, attempt);
        } catch (error) {
          outcome = {
            ok: false,
            status: "failed",
            errorCode: error instanceof Error ? error.message : String(error),
          };
        }
        if (outcome.ok) {
          if (outcome.invocationId && firstInvocationId === null) firstInvocationId = outcome.invocationId;
          results.set(batch.index, outcome.plan);
          input.onBatchDone?.(batch, outcome.plan);
          failure = null;
          break;
        }
        if (outcome.invocationId && firstInvocationId === null) firstInvocationId = outcome.invocationId;
        failure = {
          batch,
          status: outcome.status,
          errorCode: outcome.errorCode,
          ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
          ...(outcome.invocationId ? { invocationId: outcome.invocationId } : {}),
        };
        // 用户取消/运行时中断/确定性失败没有重试意义，直接让下一批处理。
        if (outcome.status === "cancelled" || outcome.status === "interrupted" || outcome.retryable === false) break;
      }
      if (failure) failures.push(failure);
    }
  });
  await Promise.all(workers);
  failures.sort((left, right) => left.batch.index - right.batch.index);
  return {
    results,
    failures,
    firstInvocationId,
    reused,
    aborted: Boolean(input.signal?.aborted),
  };
}
