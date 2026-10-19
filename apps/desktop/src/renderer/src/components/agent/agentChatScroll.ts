export const AGENT_CHAT_PIN_THRESHOLD_PX = 32

/** 恢复吸底的判定距离。流式增长平均每帧几十像素、大块插入可过百：精确的
 * ≤32px 判定在一帧窗口内时灵时不灵（概率性「卡在某个高度」），放宽到 160px。
 * 只作用于用户手势：滚回底部附近、点击「回到最新」、发出新消息；解除吸底后
 * 不存在任何无手势的自动回吸（#297：自动回吸会把上滑阅读的用户拽回底部）。 */
export const AGENT_CHAT_REPIN_DISTANCE_PX = 160

export function isScrolledToBottom(
  element: HTMLElement,
  threshold: number = 32,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
}
