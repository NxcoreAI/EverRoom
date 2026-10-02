/**
 * deck-composer 子 Agent 的信息密度编排支撑（DeckGen 比赛项目 W4）：
 * DensityPlan 归一/校验与页大纲构建。契约唯一真源：deckgen 仓
 * docs/contracts/density-plan.schema.json（v1.0-rc1）。
 * 与 deck-draft / deck-reorder 同构：只放与 orchestrator 无耦合的纯函数与常量。
 */
import type { DeckDraftSpec } from "./deck-draft.js";

export const DECK_DENSITY_TASK_LABEL = "信息密度编排";

/** EverRoom MAX_SLIDES_PAGES = 24（context_room_slides_create 的页数上限）。 */
export const MAX_DECK_PAGES = 24;

export const DENSITY_BUDGETS = ["sparse", "normal", "dense"] as const;
export type DensityBudget = (typeof DENSITY_BUDGETS)[number];

/** 版式提示词汇（对齐 slides PageSpec 版式词汇；不强制白名单，提示供 set_page 参考）。 */
export const LAYOUT_HINT_VOCABULARY = [
  "title", "cover", "section", "body", "text", "body_list", "image", "chart",
  "comparison", "quote", "timeline", "closing",
] as const;

export interface DensityPage {
  pageNo: number;
  blockIds: string[];
  layoutHint: string;
  densityBudget: DensityBudget;
  splitFrom?: number;
}

export interface DeckDensityPlan {
  pages: DensityPage[];
}

function rowOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * DensityPlan 归一与校验（跨字段语义）：
 * ① 页号从 0 连续递增，1..MAX_DECK_PAGES 页；
 * ② blockIds ⊆ 受众重排后的非 cut 块，且覆盖全部非 cut 块（拆分块允许多页出现）；
 * ③ splitFrom 必须指向更早的页（拆分链向前引用）。
 */
export function normalizeDensityPlan(
  output: Record<string, unknown>,
  orderedBlockIds: readonly string[],
): DeckDensityPlan | null {
  if (output.kind !== "density-plan") return null;
  const allowed = new Set(orderedBlockIds);
  if (!Array.isArray(output.pages) || output.pages.length < 1 || output.pages.length > MAX_DECK_PAGES) {
    return null;
  }
  const pages: DensityPage[] = [];
  const covered = new Set<string>();
  for (const [index, entry] of output.pages.entries()) {
    const row = rowOf(entry);
    if (!row) return null;
    if (row.pageNo !== index) return null;
    if (!Array.isArray(row.blockIds)) return null;
    const blockIds: string[] = [];
    for (const id of row.blockIds) {
      if (typeof id !== "string" || !allowed.has(id) || blockIds.includes(id)) return null;
      blockIds.push(id);
      covered.add(id);
    }
    const layoutHint = typeof row.layoutHint === "string" ? row.layoutHint.trim() : "";
    if (!layoutHint || layoutHint.length > 200) return null;
    if (!(DENSITY_BUDGETS as readonly string[]).includes(String(row.densityBudget))) return null;
    const page: DensityPage = {
      pageNo: index,
      blockIds,
      layoutHint,
      densityBudget: row.densityBudget as DensityBudget,
    };
    if (row.splitFrom !== undefined && row.splitFrom !== null) {
      if (typeof row.splitFrom !== "number" || !Number.isInteger(row.splitFrom)
        || row.splitFrom < 0 || row.splitFrom >= index) return null;
      page.splitFrom = row.splitFrom;
    }
    pages.push(page);
  }
  for (const id of allowed) {
    if (!covered.has(id)) return null;
  }
  return { pages };
}

export interface DensityPageOutline {
  pageNo: number;
  title: string;
  densityBudget: DensityBudget;
  layoutHint: string;
  blockIds: string[];
  previews: string[];
  splitFrom?: number;
}

/** 页大纲（slides_create 的 outline 候选；每页标题由版式与首块论点提炼）。 */
export function densityOutlineOf(
  spec: DeckDraftSpec,
  plan: DeckDensityPlan,
): DensityPageOutline[] {
  const byId = new Map(spec.blocks.map((block) => [block.id, block]));
  return plan.pages.map((page) => {
    const previews = page.blockIds
      .map((id) => byId.get(id)?.content.slice(0, 40) ?? "")
      .filter(Boolean);
    const title = previews[0]
      ?? (page.layoutHint.includes("cover") || page.pageNo === 0 ? "封面" : "过渡页");
    return {
      pageNo: page.pageNo,
      title: title.slice(0, 60),
      densityBudget: page.densityBudget,
      layoutHint: page.layoutHint,
      blockIds: page.blockIds,
      previews,
      ...(page.splitFrom !== undefined ? { splitFrom: page.splitFrom } : {}),
    };
  });
}
