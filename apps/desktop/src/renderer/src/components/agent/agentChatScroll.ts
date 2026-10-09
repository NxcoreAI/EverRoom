export const AGENT_CHAT_PIN_THRESHOLD_PX = 32

/** 恢复吸底的判定距离。流式增长平均每帧几十像素、大块插入可过百：精确的
 * ≤32px 判定在一帧窗口内时灵时不灵（概率性「卡在某个高度」），放宽到 160px。 */
export const AGENT_CHAT_REPIN_DISTANCE_PX = 160

/** 向下滚动手势视为「想跟回底部」的距离上限：流式增长每帧可达数百像素，
 * 精确的 ≤32px 判定在手势期间必输，宽阈值只在接近底部时生效。 */
export const AGENT_CHAT_WHEEL_REPIN_DISTANCE_PX = 500

/** 解除吸底后的保护期：期间不允许自动回吸，避免「上翻一点点就被拽回去」。
 * 用户的上滚调整在一两帧内完成，600ms 足够覆盖。 */
export const AGENT_CHAT_UNPIN_GRACE_MS = 600

export function isScrolledToBottom(
  element: HTMLElement,
  threshold: number = AGENT_CHAT_PIN_THRESHOLD_PX,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
}
