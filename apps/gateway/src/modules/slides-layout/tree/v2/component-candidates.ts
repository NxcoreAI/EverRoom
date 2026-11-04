/**
 * 语义内容 → 组件候选（选型前预检）。
 *
 * 上游 relations/metric blocks 只描述"内容之间是什么关系"，不决定表达。
 * 这里按关系类型与内容类型构造候选组件：参数走正式归一（normalizeComponentLeaf），
 * 展开走真实 expandComponent，在**预留标题与页脚后的合法槽位**上探测可行性，
 * 再核对展开产物是否完整覆盖 block 内容。结果作为 layouter 输入的
 * componentCandidates——模型在写第一棵树之前就知道哪个组件装得下、参数怎么填。
 *
 * 预检不截断任何正文、数值、单位与条目：装不下或映射不进去就 feasible:false
 * 并给出分类原因（参数超限 / 内容无法完整映射 / 空间不足）。
 */

import { CANVAS_H, CANVAS_W } from "../../grid.js";
import type { LayoutContract } from "../layout-contract.js";
import type { ComponentLeaf } from "../components/index.js";
import { expandComponent, normalizeComponentLeaf } from "../components/index.js";
import { componentTextOverflow } from "../measure.js";
import type { SemanticBlock, SemanticPage } from "../../../subagents/slides-semantic-contract.js";
import { visiblePayload } from "../../../subagents/slides-semantic-bindings.js";

export interface ComponentCandidate {
  name: string;
  /** 触发候选的关系类型；"metrics" 表示指标组，"quote" 表示引用，"navigates" 表示导航。 */
  relation: string;
  /** 候选绑定的实际 block（模型据此填参数与 bindings）；完整内容组，不裁切。 */
  blockRefs: string[];
  /** 代表性合法槽位上归一 + 展开 + 内容覆盖 + 文本量测预检是否通过。 */
  feasible: boolean;
  /** 已验证槽位尺寸（px）：当前内容与参数曾在此尺寸通过预检；不是最小值，也不承诺更大尺寸可用。 */
  validatedSlot?: { w: number; h: number };
  /** 与 validatedSlot 对应的合法栅格槽位（页面级 slot 口径）。 */
  suggestedSlot?: { col: [number, number]; row: [number, number] };
  /** 预检使用的网格配置：改变内容集合、网格或组件样式后，原预检结果不再作为通过依据。 */
  validatedGrid?: { cols: number; rows: number; gutter: number; rowGutter: number; margin: number };
  /** 已通过预检的组件参数（不含 type/name/slot），可直接用于组件节点。 */
  template?: Record<string, unknown>;
  /** 不可行时的分类原因。 */
  note?: string;
}

/** 关系类型 → 候选组件（按表达贴合度排序）。比较不再映射 prosCons：泛化比较不等于利弊。 */
const RELATION_CANDIDATES: Record<string, string[]> = {
  precedes: ["timeline", "steps", "chevron"],
  causes: ["steps", "chevron"],
  contains: ["layeredStack"],
  compares: ["comparison"],
  parallel: ["featureCards", "pointList"],
};

/** 各候选的条目与字段上限（与 docs 组件参数表同源；预检据此报「参数超限」，不截断）。 */
const LIMITS: Record<string, { items?: [number, number]; fields?: Record<string, number> }> = {
  timeline: { items: [3, 6], fields: { label: 24, text: 80 } },
  steps: { items: [3, 5], fields: { title: 24, text: 80 } },
  chevron: { items: [3, 5], fields: { title: 16, text: 40 } },
  layeredStack: { items: [3, 5], fields: { title: 16, text: 60 } },
  featureCards: { items: [2, 4], fields: { title: 30, body: 200 } },
  pointList: { items: [2, 5], fields: { label: 12, body: 140 } },
  comparison: { items: [2, 4], fields: { title: 24, points: 60 } },
  stats: { items: [2, 4], fields: { value: 16, unit: 8, label: 40 } },
  kpiRows: {},
  agenda: { items: [4, 8], fields: { item: 24 } },
  quote: { fields: { text: 200, author: 40 } },
};

const MAX_CANDIDATES = 4;

function textOfBlock(block: SemanticBlock): string {
  switch (block.type) {
    case "text": return block.text;
    case "metric": return `${block.label} ${block.value}${block.unit ?? ""}`;
    case "quotation": return block.text;
    default: return "";
  }
}

/** 短标签提取（label/title 用）；完整原文必须保留在正文承载字段，不在此截断正文。 */
function headOf(text: string, max: number): string {
  const cut = text.split(/[。；;：:，,、\n]/)[0] ?? text;
  return (cut.trim() || text.trim()).slice(0, max);
}

interface Mapped {
  leaf: Record<string, unknown>;
}

/**
 * 关系 blocks → 组件参数（完整映射，不截断）。字段或条目超限时返回分类原因，
 * 让候选以 feasible:false 露出，而不是靠截断混过预检。
 */
function mapFor(name: string, blocks: SemanticBlock[]): Mapped | { overflow: string } {
  const texts = blocks.map(textOfBlock);
  const limit = LIMITS[name] ?? {};
  const fieldOver = (field: string, value: string): string | null =>
    limit.fields?.[field] !== undefined && value.length > limit.fields[field]!
      ? `${name} 字段 ${field} 超上限（${value.length} > ${limit.fields[field]} 字）：「${value.slice(0, 20)}…」`
      : null;
  const itemOver = (count: number): string | null => {
    const [min, max] = limit.items ?? [0, Infinity];
    return count < min || count > max ? `${name} 条目数 ${count} 超出 ${min}~${max}` : null;
  };
  switch (name) {
    case "timeline":
    case "steps":
    case "chevron":
    case "layeredStack": {
      const titleField = name === "timeline" ? "label" : "title";
      const titleLimit = limit.fields?.[titleField] ?? 24;
      const textLimit = limit.fields?.text ?? 80;
      const items = blocks.map((b, i) => {
        const raw = texts[i]!;
        const title = headOf(raw, titleLimit);
        const over = fieldOver(titleField, title);
        return { title, text: raw, over: over ?? (raw.length > textLimit ? `${name} 第 ${i + 1} 条正文 ${raw.length} 字超上限 ${textLimit}，不截断` : null) };
      });
      const overs = items.filter(i => i.over).map(i => i.over!);
      if (overs.length) return { overflow: overs[0]! };
      const count = itemOver(items.length);
      if (count) return { overflow: count };
      const leafItems = name === "timeline"
        ? items.map(i => ({ label: i.title, text: i.text }))
        : items.map(i => ({ title: i.title, ...(i.text.length > 0 ? { text: i.text } : {}) }));
      return { leaf: { items: leafItems } };
    }
    case "featureCards": {
      const items = blocks.map((b, i) => {
        const raw = texts[i]!;
        const title = headOf(raw, limit.fields?.title ?? 30);
        return { title, body: raw, over: fieldOver("title", title) ?? fieldOver("body", raw) };
      });
      const overs = items.filter(i => i.over).map(i => i.over!);
      if (overs.length) return { overflow: overs[0]! };
      const count = itemOver(items.length);
      if (count) return { overflow: count };
      return { leaf: { items: items.map(i => ({ title: i.title, body: i.body })) } };
    }
    case "pointList": {
      const labelLimit = limit.fields?.label ?? 12;
      const items = blocks.map((b, i) => {
        const raw = texts[i]!;
        const label = headOf(raw, labelLimit);
        return { label, body: raw, over: fieldOver("label", label) ?? fieldOver("body", raw) };
      });
      const overs = items.filter(i => i.over).map(i => i.over!);
      if (overs.length) return { overflow: overs[0]! };
      const count = itemOver(items.length);
      if (count) return { overflow: count };
      return { leaf: { items: items.map(i => ({ label: i.label, body: i.body })) } };
    }
    case "comparison": {
      if (blocks.length !== 2) return { overflow: `comparison 需要恰好两方，当前 ${blocks.length} 方` };
      const sides = blocks.map((b, i) => {
        const raw = texts[i]!;
        const title = headOf(raw, limit.fields?.title ?? 24);
        const point = raw.length > (limit.fields?.points ?? 60)
          ? null
          : raw;
        return { title, point, over: fieldOver("title", title) ?? (point === null ? `comparison 第 ${i + 1} 方说明 ${raw.length} 字超上限 ${limit.fields?.points ?? 60}，不截断` : null) };
      });
      const overs = sides.filter(s => s.over).map(s => s.over!);
      if (overs.length) return { overflow: overs[0]! };
      return { leaf: { sides: sides.map(s => ({ title: s.title, points: [s.point!] })) } };
    }
    case "stats": {
      const metrics = blocks.filter(b => b.type === "metric");
      const count = itemOver(metrics.length);
      if (count) return { overflow: count };
      for (const b of metrics) {
        if (b.type !== "metric") continue;
        const value = `${b.value}`;
        const over = fieldOver("value", value) ?? fieldOver("unit", b.unit ?? "") ?? fieldOver("label", b.label);
        if (over) return { overflow: over };
      }
      return {
        leaf: {
          items: metrics.map(b => b.type === "metric"
            ? { value: `${b.value}`, label: b.label, ...(b.unit ? { unit: b.unit } : {}) }
            : null),
        },
      };
    }
    case "kpiRows": {
      const metrics = blocks.filter(b => b.type === "metric");
      if (metrics.length < 2) return { overflow: "kpiRows 需要至少 2 条指标" };
      return { leaf: { rows: metrics.map(b => b.type === "metric" ? { label: b.label, value: `${b.value}${b.unit ?? ""}` } : null) } };
    }
    case "agenda": {
      const over = blocks.find(b => textOfBlock(b).length > (limit.fields?.item ?? 24));
      if (over) return { overflow: `agenda 条目超上限（${textOfBlock(over).length} > ${limit.fields?.item ?? 24} 字），不截断` };
      const count = itemOver(blocks.length);
      if (count) return { overflow: count };
      return { leaf: { items: texts } };
    }
    case "quote": {
      const quotes = blocks.filter(b => b.type === "quotation");
      if (quotes.length !== 1) return { overflow: `quote 候选只接受单条引用 block，当前 ${quotes.length} 条` };
      const block = quotes[0]!;
      if (block.type !== "quotation") return { overflow: "quote 候选只接受引用 block" };
      const over = fieldOver("text", block.text) ?? (block.attribution ? fieldOver("author", block.attribution) : null);
      if (over) return { overflow: over };
      return { leaf: { text: block.text, ...(block.attribution ? { author: block.attribution } : {}) } };
    }
    default:
      return { overflow: `${name} 无可靠的内容映射规则，不经文本猜测构造` };
  }
}

/**
 * 合法探测槽位（12×8 默认网格）：预留第 1 行给标题、第 8 行给页脚/页码。
 * 顺序即优先级：先约半页的代表槽位，再更宽/更整页的备选。
 */
const PROBE_SLOTS: Array<{ col: [number, number]; row: [number, number] }> = [
  { col: [1, 8], row: [2, 7] },
  { col: [1, 12], row: [2, 5] },
  { col: [1, 12], row: [2, 6] },
  { col: [1, 12], row: [2, 7] },
  { col: [1, 6], row: [3, 7] },
  { col: [1, 12], row: [2, 8] },
];

/** 与 compileV2Page.frameFor 同口径的 slot → px（无 bleed）。 */
function slotFrame(slot: { col: [number, number]; row: [number, number] }, theme: LayoutContract["theme"]): { w: number; h: number } {
  const cols = 12;
  const rows = 8;
  const gutter = theme.spacing.gutter;
  const rowGutter = 16;
  const margin = theme.spacing.margin;
  const area = { x: margin, y: margin, w: CANVAS_W - 2 * margin, h: CANVAS_H - 2 * margin };
  const cw = (area.w - (cols - 1) * gutter) / cols;
  const rh = (area.h - (rows - 1) * rowGutter) / rows;
  const [c1, c2] = slot.col;
  const [r1, r2] = slot.row;
  return {
    w: Math.round((c2 - c1 + 1) * cw + (c2 - c1) * gutter),
    h: Math.round((r2 - r1 + 1) * rh + (r2 - r1) * rowGutter),
  };
}

const compact = (value: string) => value.replace(/\s+/gu, "");

/** 展开产物必须完整覆盖每个 block 的可见载荷（数字按整串匹配）。 */
function coversBlocks(elements: unknown[], blocks: SemanticBlock[]): boolean {
  const payload = elements.flatMap(el => visiblePayload(el)).map(compact);
  const joined = payload.join("");
  for (const block of blocks) {
    for (const expected of payloadOf(block)) {
      const needle = compact(expected);
      if (!needle) continue;
      const found = /^-?\d+(?:\.\d+)?$/u.test(expected)
        ? payload.includes(needle)
        : joined.includes(needle);
      if (!found) return false;
    }
  }
  return true;
}

function payloadOf(block: SemanticBlock): string[] {
  switch (block.type) {
    // 数值与单位允许拼合出现在同一 run（kpiRows 等把 value+unit 写成一个大数字）：
    // 按「label + 拼合值」两条做子串覆盖，比裸数字更精确。
    case "metric": return [block.label, `${block.value}${block.unit ?? ""}`];
    case "quotation": return [block.text];
    default: return textOfBlock(block) ? [textOfBlock(block)] : [];
  }
}

export function componentCandidatesFor(page: SemanticPage, contract: LayoutContract): ComponentCandidate[] {
  if (["cover", "quote", "section", "closing"].includes(page.role)) return [];
  const blocks = new Map(page.blocks.map(b => [b.id, b]));
  const theme = contract.theme;

  interface Draft { name: string; relation: string; refs: string[] }
  const drafts: Draft[] = [];

  const contentRefs = (refs: string[]): SemanticBlock[] | null => {
    // 缺失 block 引用不得静默忽略：关系里有未知引用就不出候选，不出残缺候选。
    const resolved = refs.map(ref => blocks.get(ref) ?? null);
    if (resolved.some(b => b === null)) return null;
    // table/chart block 不转组件候选：它们保留自己的节点形态。
    return resolved.filter(b => b !== null && b.type !== "table" && b.type !== "chart" && b.type !== "image");
  };

  const focus = new Set(page.focusRefs);
  const relations = [...page.relations].sort((a, b) =>
    b.refs.filter(r => focus.has(r)).length - a.refs.filter(r => focus.has(r)).length);
  for (const relation of relations) {
    const names = relation.type === "navigates"
      ? ["agenda"]
      : RELATION_CANDIDATES[relation.type];
    if (!names || relation.refs.length < 2) continue;
    const blocksInRelation = contentRefs(relation.refs);
    if (!blocksInRelation || blocksInRelation.length < 2) continue;
    for (const name of names) drafts.push({ name, relation: relation.type, refs: blocksInRelation.map(b => b.id) });
  }
  const metricIds = page.blocks.filter(b => b.type === "metric" && b.mustShow).map(b => b.id);
  if (metricIds.length >= 2) drafts.push({ name: "stats", relation: "metrics", refs: metricIds });
  if (metricIds.length >= 3) drafts.push({ name: "kpiRows", relation: "metrics", refs: metricIds });
  const quoteBlock = page.blocks.find(b => b.type === "quotation" && b.mustShow);
  if (quoteBlock) drafts.push({ name: "quote", relation: "quote", refs: [quoteBlock.id] });

  const evaluate = (draft: Draft): ComponentCandidate => {
    // 完整内容组，不裁切：组太大/条目超限时以 feasible:false + 原因露出，由 agent 按语义拆组。
    const refs = draft.refs;
    const mapped = mapFor(draft.name, refs.map(ref => blocks.get(ref)!));
    if ("overflow" in mapped) {
      return { name: draft.name, relation: draft.relation, blockRefs: refs, feasible: false, note: `参数超限：${mapped.overflow}` };
    }
    let leaf: ComponentLeaf;
    try {
      leaf = normalizeComponentLeaf({ type: "component", name: draft.name, ...mapped.leaf }, "candidate");
    } catch (error) {
      return {
        name: draft.name, relation: draft.relation, blockRefs: refs, feasible: false,
        note: `参数超限：${error instanceof Error ? error.message.slice(0, 120) : "归一未通过"}`,
      };
    }
    const mappedBlocks = refs.map(ref => blocks.get(ref)!);
    let firstError: string | null = null;
    for (const slot of PROBE_SLOTS) {
      const size = slotFrame(slot, theme);
      try {
        const elements = expandComponent(leaf, { x: 0, y: 0, w: size.w, h: size.h }, theme, "candidate-probe");
        if (!coversBlocks(elements, mappedBlocks)) {
          if (firstError === null) firstError = "内容无法完整映射：组件展开后未覆盖全部原文（数值、单位或正文）";
          continue;
        }
        // 复用正式量测口径检查文本溢出：展开成功但文字超框时不得标记 feasible。
        const textOverflow = componentTextOverflow(elements);
        if (textOverflow) {
          if (firstError === null) firstError = textOverflow;
          continue;
        }
        return {
          name: draft.name,
          relation: draft.relation,
          blockRefs: refs,
          feasible: true,
          validatedSlot: size,
          suggestedSlot: slot,
          validatedGrid: {
            cols: 12, rows: 8,
            gutter: theme.spacing.gutter, rowGutter: 16, margin: theme.spacing.margin,
          },
          template: mapped.leaf,
        };
      } catch (error) {
        if (firstError === null) {
          firstError = `空间不足：${error instanceof Error ? error.message.replace(/^LAYOUT_LEAF_INVALID: /u, "").slice(0, 120) : "展开失败"}`;
        }
      }
    }
    return { name: draft.name, relation: draft.relation, blockRefs: refs, feasible: false, note: firstError ?? "空间不足：无可用合法槽位" };
  };

  // 去重：同名同 block 集合只评估一次。
  const seen = new Set<string>();
  const unique = drafts.filter(d => {
    const key = `${d.name}:${[...d.refs].sort().join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const evaluated = unique.map(evaluate);

  // 先保证不同重点内容组各占一席（focus 顺序），再补同组替代方案；共 ≤4。
  const groupKey = (refs: string[]) => [...refs].sort().join(",");
  const feasible = evaluated.filter(c => c.feasible);
  const pool = feasible.length > 0 ? feasible : evaluated;
  const picked: ComponentCandidate[] = [];
  const usedGroups = new Set<string>();
  for (const candidate of pool) {
    if (picked.length >= MAX_CANDIDATES) break;
    const group = groupKey(candidate.blockRefs);
    if (usedGroups.has(group)) continue;
    usedGroups.add(group);
    picked.push(candidate);
  }
  for (const candidate of pool) {
    if (picked.length >= MAX_CANDIDATES) break;
    if (picked.includes(candidate)) continue;
    picked.push(candidate);
  }
  return picked;
}
