/**
 * 单页只读预览上下文：layouter 在一次 invocation 内通过 slides_page_preview
 * 把当前树编译成临时单页 PPTX + PNG，拿到确定性 defects 与设计审阅；
 * 不写当前 deck，因此多页并发不会互相踩，也不需要页级回滚。
 */

import type { LayoutContract } from "./tree/layout-contract.js";
import type { LayoutDefect } from "./tree/measure.js";
import type { DesignReviewOutcome } from "../slides-visual-review/review.js";

export interface PagePreviewResult {
  /** 编译缺陷（blocking 时不渲染）。 */
  defects: LayoutDefect[];
  /** 预览 PNG；blocking 缺陷或渲染失败时为 null。 */
  png: Buffer | null;
  /** VLM 设计审阅；未配置/失败为 null。 */
  visual: DesignReviewOutcome | null;
  /** 渲染错误（若有）。 */
  error?: string;
}

export interface PagePreviewContext {
  contract: LayoutContract;
  imageArs: Map<string, number>;
  pageCount: number;
  /** 编译 + 临时渲染；只读，不触碰当前 deck。 */
  render(tree: unknown, pageIndex: number): Promise<PagePreviewResult>;
  previewed: Set<number>;
}

const contexts = new Map<string, PagePreviewContext>();

export function registerPagePreview(token: string, context: PagePreviewContext): void {
  contexts.set(token, context);
}

export function getPagePreview(token: string): PagePreviewContext | null {
  return contexts.get(token) ?? null;
}

export function markPagePreviewed(token: string, pageIndex: number): void {
  contexts.get(token)?.previewed.add(pageIndex);
}

export function wasPagePreviewed(token: string, pageIndex: number): boolean {
  return contexts.get(token)?.previewed.has(pageIndex) ?? false;
}

export function clearPagePreviewed(token: string, pageIndex: number): void {
  contexts.get(token)?.previewed.delete(pageIndex);
}

export function dropPagePreview(token: string): void {
  contexts.delete(token);
}
