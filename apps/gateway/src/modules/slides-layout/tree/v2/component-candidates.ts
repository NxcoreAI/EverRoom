/**
 * 语义内容 → 组件候选（选型前预检）。
 *
 * 上游 relations/metric blocks 只描述"内容之间是什么关系"，不决定表达。
 * 这里按关系类型生成少量候选组件，用真实展开器在代表性槽位上预检可行性
 * （分轴尝试加宽/加高），把结果作为 layouter 输入的 componentCandidates——
 * 模型在写第一棵树之前就知道哪个组件装得下、要占多大区域。
 *
 * 候选绑定实际 block（不是 role 猜测）；预检只回答"这个内容量在这个槽位
 * 能不能展开"，参数、保真与最终校验仍由模型与既有链路负责。
 */

import { CANVAS_H, CANVAS_W } from "../../grid.js";
import type { LayoutContract } from "../layout-contract.js";
import type { ComponentLeaf } from "../components/index.js";
import { expandComponent } from "../components/index.js";
import type { SemanticBlock, SemanticPage } from "../../../subagents/slides-semantic-contract.js";

export interface ComponentCandidate {
  name: string;
  /** 触发候选的关系类型；"metrics" 表示指标组。 */
  relation: string;
  /** 候选绑定的实际 block（模型据此填参数与 bindings）。 */
  blockRefs: string[];
  /** 代表性槽位（约半页）展开预检是否通过。 */
  feasible: boolean;
  /** 分轴探测的最小可行区域（px）；不可行时缺省。 */
  minSlot?: { w: number; h: number };
  /** 不可行时的缺口说明。 */
  note?: string;
}

/** 关系类型 → 候选组件（按表达贴合度排序；supports 是辅助关系，不给候选）。 */
const RELATION_CANDIDATES: Record<string, string[]> = {
  precedes: ["timeline", "steps", "chevron"],
  causes: ["steps", "chevron"],
  contains: ["layeredStack"],
  compares: ["comparison", "prosCons"],
  parallel: ["featureCards", "pointList"],
};

const MAX_CANDIDATES = 4;

function textOfBlock(block: SemanticBlock): string {
  switch (block.type) {
    case "text": return block.text;
    case "metric": return `${block.label} ${block.value}${block.unit ?? ""}`;
    case "quotation": return block.text;
    case "table": return block.headers.join(" ") + block.rows.flat().join(" ");
    case "chart": return block.labels.join(" ") + block.series.flatMap(s => [s.name, ...s.values.map(String)]).join(" ");
    default: return "";
  }
}

/** 长文取标题候选：第一句 / 前顿号，供 label/title 字段用。 */
function headOf(text: string, max: number): string {
  const cut = text.split(/[。；;：:，,、\n]/)[0] ?? text;
  return (cut.trim() || text.trim()).slice(0, max);
}

/** 按组件名把实际 block 内容映射成展开器参数（长度按组件容量口径截断）。 */
function leafFor(name: string, blocks: SemanticBlock[]): ComponentLeaf | null {
  const texts = blocks.map(textOfBlock);
  switch (name) {
    case "timeline":
      if (blocks.length < 2) return null;
      return { type: "component", name: "timeline", items: blocks.map((b, i) => ({ label: headOf(texts[i]!, 8) || `阶段 ${i + 1}`, text: texts[i]!.slice(0, 40) })) };
    case "steps":
    case "chevron":
    case "layeredStack":
      if (blocks.length < 2) return null;
      return {
        type: "component", name,
        items: blocks.map((b, i) => ({ title: headOf(texts[i]!, 10) || `第 ${i + 1} 步`, ...(texts[i]!.length > 10 ? { text: texts[i]!.slice(0, 60) } : {}) })),
      } as ComponentLeaf;
    case "featureCards":
    case "pointList":
      if (blocks.length < 2) return null;
      return {
        type: "component", name,
        items: blocks.map((b, i) => ({ label: headOf(texts[i]!, 10) || `要点 ${i + 1}`, body: texts[i]!.slice(0, 80) })),
      } as ComponentLeaf;
    case "comparison":
      if (blocks.length !== 2) return null;
      return {
        type: "component", name: "comparison",
        sides: blocks.map((b, i) => ({ title: headOf(texts[i]!, 12) || `对照 ${i + 1}`, points: [texts[i]!.slice(0, 60)] })),
      };
    case "prosCons":
      if (blocks.length !== 2) return null;
      return { type: "component", name: "prosCons", pros: [texts[0]!.slice(0, 40)], cons: [texts[1]!.slice(0, 40)] };
    case "stats": {
      const metrics = blocks.filter(b => b.type === "metric");
      if (metrics.length < 2) return null;
      return {
        type: "component", name: "stats",
        items: metrics.map(b => b.type === "metric"
          ? { value: String(b.value).slice(0, 14), label: b.label.slice(0, 20), ...(b.unit ? { unit: b.unit.slice(0, 8) } : {}) }
          : { value: "", label: "" }),
      };
    }
    default:
      return null;
  }
}

/** 代表性槽位（近似 v2 内容区）：约半页 / 偏宽 / 偏高 / 整页——分轴探测。 */
function probeFrames(margin: number): Array<{ w: number; h: number }> {
  const w = CANVAS_W - margin * 2;
  const h = CANVAS_H - margin * 2;
  return [
    { w: Math.round(w * 0.6), h: Math.round(h * 0.5) },
    { w, h: Math.round(h * 0.4) },
    { w: Math.round(w * 0.5), h: Math.round(h * 0.7) },
    { w, h },
  ];
}

function expandsAt(leaf: ComponentLeaf, w: number, h: number, theme: LayoutContract["theme"]): boolean {
  try {
    expandComponent(leaf, { x: 0, y: 0, w, h }, theme, "candidate-probe");
    return true;
  } catch {
    return false;
  }
}

export function componentCandidatesFor(page: SemanticPage, contract: LayoutContract): ComponentCandidate[] {
  if (["cover", "quote", "section", "closing"].includes(page.role)) return [];
  const blocks = new Map(page.blocks.map(b => [b.id, b]));
  const byBlock = (refs: string[]): SemanticBlock[] =>
    refs.flatMap(ref => blocks.get(ref) ?? []).filter(b => b.type !== "image");
  const frames = probeFrames(contract.theme.spacing.margin);
  const out: ComponentCandidate[] = [];

  const consider = (name: string, relation: string, refs: string[]): void => {
    const leaf = leafFor(name, byBlock(refs));
    if (!leaf) return;
    const passing = frames.find(f => expandsAt(leaf, f.w, f.h, contract.theme));
    out.push({
      name,
      relation,
      blockRefs: refs.slice(0, 8),
      feasible: passing !== undefined,
      ...(passing ? { minSlot: { w: passing.w, h: passing.h } } : { note: "当前内容量在整页可分配区域内都装不下：精简条目或拆页" }),
    });
  };

  // 主关系优先：focusRefs 命中的关系排前。
  const focus = new Set(page.focusRefs);
  const relations = [...page.relations].sort((a, b) =>
    b.refs.filter(r => focus.has(r)).length - a.refs.filter(r => focus.has(r)).length);
  for (const relation of relations) {
    const names = RELATION_CANDIDATES[relation.type];
    if (!names || relation.refs.length < 2) continue;
    const refs = relation.refs.filter(ref => blocks.get(ref)?.type !== "image");
    if (refs.length < 2) continue;
    for (const name of names) consider(name, relation.type, refs);
  }
  const metricIds = page.blocks.filter(b => b.type === "metric" && b.mustShow).map(b => b.id);
  if (metricIds.length >= 2) consider("stats", "metrics", metricIds);

  const feasible = out.filter(c => c.feasible);
  return (feasible.length > 0 ? feasible : out).slice(0, MAX_CANDIDATES);
}
