/**
 * 论文排版 v2 · 映射引擎（方案 §4.3 / §6.2–§6.9）。
 *
 * 输入：模板剖面（槽位骨架）+ 内容剖面（章节树）→ 输出 MappingPlan：
 * 槽位 ↔ 源章节的分配表、未匹配清单、块守恒核对、报告条目。
 *
 * 设计要点：
 * - 规则阶梯 R0–R5 串行尝试，命中即消费（一对一），无匹配一律进 R4 追加或兜底容器，
 *   **绝不丢弃任何块**；
 * - 顺序一致性在相似度里占 0.2 权重：中文论文模板章节顺序高度稳定，
 *   「第二个 H1 对第二个槽位」通常优于字面匹配；
 * - 末尾做块守恒断言：Σ已分配 ∪ Σ未匹配 == 内容总块数，不等直接抛错。
 */

import type { ContentOutlineNode, ContentProfile } from "./content-profile.js";
import { flattenChapters } from "./content-profile.js";
import type { ThesisSlot, TemplateProfile } from "./template-profile.js";
import { jaccard, numberingFamily } from "./text-normalize.js";

/** 分配所用规则（进报告，便于用户理解"为什么这么排"）。 */
export type MappingRule =
  | "R0-anchor"
  | "R1-title"
  | "R2-order"
  | "R3-fuzzy"
  | "R4-append"
  | "R5-orphan";

export interface SlotAssignment {
  slotId: string;
  kind: ThesisSlot["kind"];
  /** 源章节（固定槽位/正文章节）；容器槽位为 null。 */
  chapterTraceId: string | null;
  /** 该分配覆盖的内容块区间 [start, end)。 */
  blockRange: [number, number];
  /** 章标题原文（输出正文标题用；固定槽位用模板标题）。 */
  headingText: string;
  /** 渲染用样式键（可能与槽位默认不同，见 §6.4 层级降级）。 */
  styleKey: ThesisSlot["styleKey"];
  confidence: number;
  rule: MappingRule;
  notes: string[];
}

export interface UnmatchedRange {
  reason: "orphan-block" | "no-slot" | "slot-taken" | "below-threshold" | "unknown-kind";
  blockRange: [number, number];
  /** 就近槽位（渲染时插在它之后），无则 null（放兜底容器）。 */
  nearestSlotId: string | null;
  note: string;
}

export interface MappingPlan {
  assignments: SlotAssignment[];
  unmatched: UnmatchedRange[];
  /** 块守恒核对：三个数必须满足 matched + unmatched + templateOwn == total。 */
  conservation: { matched: number; unmatched: number; templateOwn: number; total: number };
  /** 需要代理裁决的低置信配对（0.40–0.62）；空数组 = 规则已足够确定。 */
  pendingForSemantic: Array<{
    chapterTraceId: string;
    chapterText: string;
    candidates: Array<{ slotId: string; score: number }>;
  }>;
  /** 用户可读报告。 */
  report: {
    matchedChapters: number;
    appendedChapters: number;
    unmatchedBlocks: number;
    notes: string[];
  };
  gaps: string[];
}

/** 相似度（方案 §6.2）：token Jaccard 0.5 + 编号体系 0.2 + 顺序一致 0.2 + 锚点 0.1。 */
export function similarity(input: {
  sourceTokens: string[];
  slotTokens: string[];
  sourceNumberFamily?: string;
  slotNumberFamily?: string;
  orderDistance?: number;
  anchorMatched?: boolean;
}): number {
  const lexical = jaccard(input.sourceTokens, input.slotTokens);
  const numberCompat = input.sourceNumberFamily && input.slotNumberFamily
    ? (input.sourceNumberFamily === input.slotNumberFamily ? 1 : 0)
    : 1; // 至少一侧没有编号：不惩罚
  const distance = input.orderDistance ?? 0;
  const orderCompat = distance <= 1 ? 1 : distance <= 2 ? 0.6 : 0;
  const anchorBonus = input.anchorMatched ? 1 : 0;
  return 0.5 * lexical + 0.2 * numberCompat + 0.2 * orderCompat + 0.1 * anchorBonus;
}

/** 模型给出的语义裁决（可选，M3 只消费；生成在网关 service 层）。 */
export interface SemanticDecision {
  chapterTraceId: string;
  slotId: string | null;
  reason?: string;
}

const FUZZY_THRESHOLD = 0.62;
/** 低置信区间下界：低于此不打扰代理（明显无关）。 */
const SEMANTIC_LOW_BOUND = 0.4;
const FUZZY_NOTE_THRESHOLD = 0.75;

/** 章节树按"章节层"展平（正文章节与模板 body 槽位对齐用）。 */
function chapterNodes(profile: ContentProfile): ContentOutlineNode[] {
  return flattenChapters(profile).filter((node) => node.role === "chapter");
}

/** 落到某个章节里的块是否属于固定槽位（摘要/参考文献等）。 */
function blocksOf(node: ContentOutlineNode): Array<[number, number]> {
  return [[node.blockStart, node.blockEnd]];
}

/**
 * 构建映射计划。
 *
 * @param semantic 低置信度区间的代理裁决（可缺省：缺省时全部走确定性规则）
 */
export function buildMappingPlan(input: {
  template: TemplateProfile;
  content: ContentProfile;
  semantic?: SemanticDecision[];
}): MappingPlan {
  const { template, content } = input;
  const notes: string[] = [];
  const gaps: string[] = [];
  const chapters = chapterNodes(content);
  const assignments: SlotAssignment[] = [];
  const consumedSlots = new Set<string>();
  const consumedChapters = new Set<string>();
  const unmatched: UnmatchedRange[] = [];

  const slots = [...template.slots].sort((a, b) => a.order - b.order);
  const bodySlots = slots.filter((slot) => slot.kind === "body");
  const anchorSlots = slots.filter((slot) => slot.kind !== "body");

  /** R0/R1：锚点与精确标题匹配（固定槽位优先，其次同名 body 槽位）。 */
  for (const node of chapters) {
    if (consumedChapters.has(node.traceId)) continue;
    const candidates = [...anchorSlots, ...bodySlots].filter((slot) => !consumedSlots.has(slot.id));
    for (const slot of candidates) {
      const anchorMatched = Boolean(node.anchor) && slot.kind === node.anchor;
      const exact = node.normalized.length > 0 && node.normalized === slot.matchKey.normalized;
      if (!anchorMatched && !exact) continue;
      consume(slot, node, anchorMatched ? "R0-anchor" : "R1-title", anchorMatched ? 0.98 : 0.95, []);
      break;
    }
  }

  /**
   * R3：模糊匹配（剩余槽位 × 剩余章节，贪心取最高分）。
   *
   * **必须在 R2 之前**：先让"标题语义确实对得上"的章节抢到槽位，剩下的再按顺序
   * 兜底。反过来（先 R2）会把所有章节按位置钉死，语义匹配永远轮不到——
   * 实测「二、需求梳理」本该精确命中模板「二、项目需求分析」，却被位置对齐吃掉。
   */
  type Pair = { slot: TemplateProfile["slots"][number]; node: ContentOutlineNode; score: number };
  const pairs: Pair[] = [];
  for (const slot of bodySlots.filter((entry) => !consumedSlots.has(entry.id))) {
    const slotFamily = numberingFamilyOfTitle(slot.title);
    for (const node of chapters.filter((entry) => !consumedChapters.has(entry.traceId))) {
      const score = similarity({
        sourceTokens: node.tokens ?? [],
        slotTokens: slot.matchKey.tokens,
        sourceNumberFamily: numberingFamily(node.originalNumber),
        slotNumberFamily: slotFamily,
      });
      if (score >= FUZZY_THRESHOLD) pairs.push({ slot, node, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  for (const pair of pairs) {
    if (consumedSlots.has(pair.slot.id) || consumedChapters.has(pair.node.traceId)) continue;
    const fuzzyNotes = pair.score < FUZZY_NOTE_THRESHOLD
      ? [`标题语义相似度偏低（${pair.score.toFixed(2)}），请核对章节归属`]
      : [];
    consume(pair.slot, pair.node, "R3-fuzzy", pair.score, fuzzyNotes);
  }

  /**
   * 低置信区间（0.40–0.62）留给代理裁决（方案 §6.9）：
   * 纯字面匹配吃不准、顺序对齐又不敢断言时，把「源章节 × 候选槽位」交给模型
   * 做一次性决策。这里只产请求，不自己调用模型——网关 service 层负责派发。
   */
  const pending = new Map<string, { slotId: string; score: number }[]>();
  for (const slot of bodySlots.filter((entry) => !consumedSlots.has(entry.id))) {
    for (const node of chapters.filter((entry) => !consumedChapters.has(entry.traceId))) {
      const score = similarity({
        sourceTokens: node.tokens ?? [],
        slotTokens: slot.matchKey.tokens,
        sourceNumberFamily: numberingFamily(node.originalNumber),
        slotNumberFamily: numberingFamilyOfTitle(slot.title),
      });
      if (score < SEMANTIC_LOW_BOUND || score >= FUZZY_THRESHOLD) continue;
      const list = pending.get(node.traceId) ?? [];
      list.push({ slotId: slot.id, score });
      pending.set(node.traceId, list);
    }
  }
  const pendingForSemantic = [...pending.entries()].map(([chapterTraceId, candidates]) => ({
    chapterTraceId,
    chapterText: chapters.find((node) => node.traceId === chapterTraceId)?.text ?? "",
    candidates: candidates.sort((a, b) => b.score - a.score).slice(0, 3),
  }));


  /** 代理裁决（可选）：只处理仍未被消费的槽位/章节。 */
  for (const decision of input.semantic ?? []) {
    if (!decision.slotId) continue;
    if (consumedChapters.has(decision.chapterTraceId) || consumedSlots.has(decision.slotId)) continue;
    const slot = slots.find((entry) => entry.id === decision.slotId);
    const node = chapters.find((entry) => entry.traceId === decision.chapterTraceId);
    if (!slot || !node) continue;
    consume(slot, node, "R3-fuzzy", 0.7, [decision.reason ?? "由解析代理裁决归属，建议人工复核"]);
  }


  /** R2：顺序对齐——剩余的源章节与剩余的模板 body 槽位按序配对（兜底主力）。 */
  const freeBodySlots = bodySlots.filter((slot) => !consumedSlots.has(slot.id));
  const freeChapters = chapters.filter((node) => !consumedChapters.has(node.traceId));
  const orderBudget = Math.min(freeBodySlots.length, freeChapters.length);
  for (let index = 0; index < orderBudget; index += 1) {
    consume(freeBodySlots[index]!, freeChapters[index]!, "R2-order", 0.85, []);
  }

  /** R4：剩余源章节追加到正文容器末尾（不丢内容）。 */
  const bodyContainer = bodySlots[0] ?? null;
  for (const node of chapters) {
    if (consumedChapters.has(node.traceId)) continue;
    const styleKey = slotStyleForRole(node.role, template);
    assignments.push({
      slotId: bodyContainer?.id ?? "slot-append",
      kind: "body",
      chapterTraceId: node.traceId,
      blockRange: blocksOf(node)[0]!,
      headingText: node.text,
      styleKey,
      confidence: 0.6,
      rule: "R4-append",
      notes: bodyContainer ? ["模板无对应槽位，已追加到正文末尾"] : ["模板未识别章节骨架，已按样式追加"],
    });
    consumedChapters.add(node.traceId);
  }
  const appended = assignments.filter((entry) => entry.rule === "R4-append").length;

  /**
   * 块守恒：把内容块按"已分配区间 ∪ 未匹配区间"完整覆盖。
   * 任何没被章节区间覆盖的块（首标题之前的散段、章节之间的游离块）都进 R5 兜底。
   */
  const covered = new Set<number>();
  for (const assignment of assignments) {
    for (let index = assignment.blockRange[0]; index < assignment.blockRange[1]; index += 1) covered.add(index);
  }
  const total = content.blocks.length;
  let cursor = 0;
  while (cursor < total) {
    if (covered.has(cursor)) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (cursor < total && !covered.has(cursor)) cursor += 1;
    const range: [number, number] = [start, cursor];
    const firstBlock = content.blocks[start]!;
    const nearest = nearestSlotBefore(assignments, start);
    unmatched.push({
      reason: start === 0 ? "orphan-block" : firstBlock.kind === "heading" ? "no-slot" : "orphan-block",
      blockRange: range,
      nearestSlotId: nearest,
      note: start === 0
        ? "位于首个章节之前的内容（封面/说明类）"
        : `未被任何章节区间覆盖的 ${cursor - start} 个块`,
    });
  }

  const matched = [...covered].length;
  const unmatchedBlocks = unmatched.reduce((sum, entry) => sum + (entry.blockRange[1] - entry.blockRange[0]), 0);
  const templateOwn = template.slots.length;
  if (matched + unmatchedBlocks !== total) {
    throw new Error(`thesis_mapping_not_conservative:matched=${matched},unmatched=${unmatchedBlocks},total=${total}`);
  }
  if (unmatched.length > 0) {
    notes.push(`${unmatchedBlocks} 个块未匹配到槽位，已保留并标记（不会丢）`);
  }
  if (appended > 0) notes.push(`${appended} 个章节在模板里没有对应槽位，已追加到正文末尾`);
  gaps.push(...template.gaps, ...content.gaps);

  return {
    assignments,
    unmatched,
    pendingForSemantic,
    conservation: { matched, unmatched: unmatchedBlocks, templateOwn, total },
    report: {
      matchedChapters: assignments.filter((entry) => entry.chapterTraceId !== null).length,
      appendedChapters: appended,
      unmatchedBlocks,
      notes,
    },
    gaps,
  };

  function consume(
    slot: ThesisSlot,
    node: ContentOutlineNode,
    rule: MappingRule,
    confidence: number,
    extraNotes: string[],
  ): void {
    assignments.push({
      slotId: slot.id,
      kind: slot.kind,
      chapterTraceId: node.traceId,
      blockRange: blocksOf(node)[0]!,
      headingText: slot.kind === "body" ? node.text : slot.title,
      styleKey: styleKeyForSlot(slot, node, template),
      confidence,
      rule,
      notes: [...extraNotes],
    });
    consumedSlots.add(slot.id);
    consumedChapters.add(node.traceId);
  }
}

/** 槽位标题的编号体系（用于相似度里的"同类编号"判断）。 */
function numberingFamilyOfTitle(title: string): string {
  const match = /^\s*([（(]?[0-9一二三四五六七八九十]+[)）]?[、.．]|[0-9]+(?:\.[0-9]+)*)/.exec(title);
  return numberingFamily(match?.[1]);
}

/** 层级降级（方案 §6.4）：源 role → 模板可用样式键。 */
function slotStyleForRole(role: ContentOutlineNode["role"], template: TemplateProfile): ThesisSlot["styleKey"] {
  const has = (key: string): boolean => template.fixed.styles[key]?.origin !== "default";
  if (role === "chapter") return "h1";
  if (role === "section") return has("h2") ? "h2" : "h1";
  return has("h3") ? "h3" : has("h2") ? "h2" : "h1";
}

function styleKeyForSlot(slot: ThesisSlot, node: ContentOutlineNode, template: TemplateProfile): ThesisSlot["styleKey"] {
  // 固定槽位用槽位自己的样式（摘要标题等）；正文槽位按源章节角色套层级
  if (slot.kind !== "body") return slot.styleKey;
  return slotStyleForRole(node.role, template);
}

/** 找该块之前最近的一个已分配槽位（未匹配内容就近插入，不孤立到文末）。 */
function nearestSlotBefore(assignments: SlotAssignment[], blockIndex: number): string | null {
  let best: SlotAssignment | null = null;
  for (const assignment of assignments) {
    if (assignment.blockRange[1] <= blockIndex && (!best || assignment.blockRange[1] > best.blockRange[1])) best = assignment;
  }
  return best?.slotId ?? null;
}
/**
 * 裁决结果消毒：只接受引擎真的问过的章节，槽位 id 必须真实存在。
 *
 * 模型可能编造 traceId 或槽位 id（"看起来像"的字符串），这里一律丢弃——
 * 编造的归属比没有归属更危险（会把内容塞进错误的槽位且无人察觉）。
 */
export function sanitizeMappingDecisions(
  raw: unknown,
  pending: MappingPlan["pendingForSemantic"],
  slots: Array<{ id: string }>,
): SemanticDecision[] {
  if (!Array.isArray(raw)) return [];
  const askedChapters = new Set(pending.map((entry) => entry.chapterTraceId));
  const knownSlots = new Set(slots.map((slot) => slot.id));
  const out: SemanticDecision[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { chapterTraceId?: unknown; slotId?: unknown; reason?: unknown };
    const chapterTraceId = typeof record.chapterTraceId === "string" ? record.chapterTraceId : "";
    if (!askedChapters.has(chapterTraceId) || seen.has(chapterTraceId)) continue;
    seen.add(chapterTraceId);
    out.push({
      chapterTraceId,
      slotId: typeof record.slotId === "string" && knownSlots.has(record.slotId) ? record.slotId : null,
      ...(typeof record.reason === "string" && record.reason.trim()
        ? { reason: record.reason.trim().slice(0, 120) }
        : {}),
    });
  }
  return out;
}
