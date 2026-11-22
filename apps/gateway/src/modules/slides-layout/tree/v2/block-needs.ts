/**
 * 语义内容块 → 实测区域需求（随 layouter 输入下发）。
 *
 * 候选预检（componentCandidates.validatedSlot）只覆盖映射到候选组件的关系组；
 * 这里补齐其余内容块——裸文本、表格、图表——的引擎同口径量测，让模型在写
 * 第一棵树之前就拿到「每块内容需要多大」的数字，而不是靠字数直觉拍区域、
 * 等校验失败再返工。量测与 measure/componentTextOverflow 同一估算口径。
 */

import type { LayoutContract } from "../layout-contract.js";
import { CANVAS_H, CANVAS_W } from "../../grid.js";
import { estimateLineHeight, estimateTextWidth } from "../../text-metrics.js";
import type { SemanticBlock, SemanticPage } from "../../../subagents/slides-semantic-contract.js";

export interface BlockNeed {
  blockId: string;
  kind: "text" | "table" | "chart";
  /** text：按 3/6/12 列宽（12×8 网格口径）实测的内容高度；字号取 body 档。 */
  heightsByWidth?: Array<{ cols: number; px: number }>;
  /** table：总行数（含表头）与估算高度。 */
  rows?: number;
  estimatedPx?: number;
  /** table/chart：放得下的建议槽位（12×8 口径）。 */
  suggestedSlot?: { col: [number, number]; row: [number, number] };
}

/** 与 component-candidates.slotFrame 同口径的栅格列宽（无 bleed）。 */
function columnWidth(contract: LayoutContract): number {
  const area = CANVAS_W - 2 * contract.theme.spacing.margin;
  return (area - 11 * contract.theme.spacing.gutter) / 12;
}

/** 文本按给定列数（跨 gutter 合并）实测高度：折行数 × 行高，与校验估算同口径。 */
function textHeightAt(text: string, sizePt: number, cols: number, cw: number, gutter: number): number {
  const width = Math.max(1, cols * cw + (cols - 1) * gutter);
  const lines = Math.max(1, Math.ceil(estimateTextWidth(text, sizePt) / width));
  return Math.round(lines * estimateLineHeight(sizePt));
}

/** 表格行高（含内边距）与表头加成：引擎默认字号的实测口径。 */
const TABLE_ROW_PX = 32;
const TABLE_HEADER_PX = 40;

export function blockNeedsFor(page: SemanticPage, contract: LayoutContract): BlockNeed[] {
  const cw = columnWidth(contract);
  const gutter = contract.theme.spacing.gutter;
  const bodySize = contract.theme.typeScale.body;
  const needs: BlockNeed[] = [];
  for (const block of page.blocks) {
    if (block.type === "table") {
      const rows = block.rows.length + 1;
      needs.push({
        blockId: block.id,
        kind: "table",
        rows,
        estimatedPx: rows * TABLE_ROW_PX + TABLE_HEADER_PX,
        suggestedSlot: { col: [1, Math.min(12, Math.max(4, block.headers.length * 2))], row: [3, 8] },
      });
      continue;
    }
    if (block.type === "chart") {
      needs.push({ blockId: block.id, kind: "chart", suggestedSlot: { col: [5, 12], row: [2, 6] } });
      continue;
    }
    // text / metric / quotation 都按裸文本承载口径量测（metric 拼 label+value+unit）；
    // image 的长宽比已在 materials 里给出，不产需求。
    let text: string;
    if (block.type === "text" || block.type === "quotation") text = block.text;
    else if (block.type === "metric") text = `${block.label} ${block.value}${block.unit ?? ""}`;
    else continue;
    if (!text.trim()) continue;
    needs.push({
      blockId: block.id,
      kind: "text",
      heightsByWidth: [3, 6, 12].map((cols) => ({ cols, px: textHeightAt(text, bodySize, cols, cw, gutter) })),
    });
  }
  // ponytail: CANVAS_H 暂未参与（行高按内容算，不封页高）；表格行数超页高时由校验兜。
  void CANVAS_H;
  return needs;
}
