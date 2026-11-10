/**
 * deck 布局契约上下文：一次 generate 尾部注册 token → {contract, imageArs}，
 * validate 工具按 token 取用（模型不回传契约，防漂移）。进程内生命周期＝单次生成。
 */

import type { LayoutContract } from "./tree/layout-contract.js";

export interface DeckLayoutContext {
  contract: LayoutContract;
  /** 图片 url → 长宽比（宽/高）；取不到的 url 不在 Map 里。 */
  imageArs: Map<string, number>;
  /**
   * 最后一次 validate 通过（非 forcedSubmission）的归一树 JSON。
   * deck 会话严格串行，单槽即当前页；提交闸据此对账——校验的树 = 提交的树 = 落页的树，
   * 模型重抄 JSON 的几何漂移在提交时被点名，而不是漏到落页才拒。
   */
  lastValidatedTreeJson?: string | undefined;
}

const contexts = new Map<string, DeckLayoutContext>();

export function registerDeckLayoutContext(token: string, context: DeckLayoutContext): void {
  contexts.set(token, context);
}

export function getDeckLayoutContext(token: unknown): DeckLayoutContext | undefined {
  if (typeof token !== "string" || !token.trim()) return undefined;
  return contexts.get(token);
}

export function dropDeckLayoutContext(token: string): void {
  contexts.delete(token);
}
