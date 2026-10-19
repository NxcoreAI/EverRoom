/**
 * 审页说明书上下文：布局尾部在派发 slides-reviewer 前按 manualToken（随 reviewer
 * 输入下发的短寻址 id）注册 {页内容, 当前树, deckToken}；reviewer 决定修改时经
 * slides_review_manual 按需取用。进程内生命周期＝单次生成（尾部 finally 清理）。
 */

import type { LayoutTree } from "./tree/schema.js";

export interface ReviewManual {
  deckToken: string;
  page: Record<string, unknown>;
  currentTree: LayoutTree;
}

const manuals = new Map<string, ReviewManual>();

export function registerReviewManual(manualToken: string, manual: ReviewManual): void {
  manuals.set(manualToken, manual);
}

/** 尾部收尾清理：一次生成对应一组 manualToken（前缀 `${token}#`）。 */
export function dropReviewManuals(prefix: string): void {
  for (const entry of manuals.keys()) {
    if (entry.startsWith(prefix)) manuals.delete(entry);
  }
}

export function takeReviewManual(manualToken: unknown): ReviewManual | null {
  if (typeof manualToken !== "string" || !manualToken) return null;
  return manuals.get(manualToken) ?? null;
}
