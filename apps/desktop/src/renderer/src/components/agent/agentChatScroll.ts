export const AGENT_CHAT_PIN_THRESHOLD_PX = 32

/** 手势回吸的判定距离。
 * 曾有 160px 的宽阈值，理由是流式增长每帧几十到上百像素、精确判定会「概率性吸不上」；
 * 但手势路径一旦放宽，就会把对话区尾部的预留 padding（输入框高度 + 34px，≥166px）当成
 * 「底部附近」：靠近底部的任何一次下滚都会被判成「想跟回」并把 scrollTop 直接顶到
 * scrollHeight，表现为磁吸、回弹、被反复拽回底部。流式跟随由吸底后的 MutationObserver
 * 负责，不需要宽阈值兜底；因此回吸只认「确实已到可见底部附近」的 PIN 阈值。
 * 只作用于用户手势：滚回底部附近、点击「回到最新」、发出新消息（#297）。 */
export const AGENT_CHAT_REPIN_DISTANCE_PX = AGENT_CHAT_PIN_THRESHOLD_PX

/** 上滑解除吸底的最小位移。触控板慢扫/平滑滚动收尾是 ±0.5px 级亚像素步进，
 * 单个事件就 detach 会让按钮闪、状态抖；按方向累计到 2px 再脱离，既滤掉噪声，
 * 也不会让「极慢上滑」永远离不开底部（每帧流式增长都会把视图拽回）。 */
export const AGENT_CHAT_WHEEL_UP_DETACH_PX = 2

export interface ScrollGeometrySample {
  lastScrollTop: number
  scrollTop: number
  lastScrollHeight: number
  scrollHeight: number
  lastClientHeight: number
  clientHeight: number
}

/** scrollTop 变小不一定来自用户手势：内容变矮（折叠卡、图片重排）或视口变高、
 * 输入框变矮导致尾部 padding 收缩时，浏览器会把 scrollTop 夹回新的最大滚动位置，
 * 并照常派发 scroll 事件。若把它当成「用户上滑」就会误脱离吸底（人还在底部却弹出
 * 「回到最新」），下一次下滚又被吸回来，形成抖动闭环。
 * 判据一：clamp 只会把 scrollTop 收到新的最大滚动位置，事件发生后必然仍贴着新底部；
 * 判据二：滚动锚定会把 scrollTop 与 scrollHeight 同量下调，此时底部距离仍很大。 */
export function isGeometryClampScroll(sample: ScrollGeometrySample): boolean {
  const movedUp = sample.lastScrollTop - sample.scrollTop
  if (movedUp <= 1) return false
  const remaining = sample.scrollHeight - sample.scrollTop - sample.clientHeight
  if (remaining <= 1) return true
  const shrink = Math.max(0, sample.lastScrollHeight - sample.scrollHeight)
    + Math.max(0, sample.clientHeight - sample.lastClientHeight)
  if (shrink < 1) return false
  return movedUp <= shrink + 1
}

/** 内层元素能否吃掉这段纵向 wheel 位移（纯函数，便于在无 DOM 环境断言）。 */
export function canConsumeVerticalWheel(
  state: { scrollTop: number; scrollHeight: number; clientHeight: number; overflowY: string | undefined },
  deltaY: number,
): boolean {
  const maxScrollTop = state.scrollHeight - state.clientHeight
  if (maxScrollTop <= 1) return false
  if (state.overflowY !== 'auto' && state.overflowY !== 'scroll') return false
  if (deltaY < 0) return state.scrollTop > 0
  if (deltaY > 0) return state.scrollTop < maxScrollTop - 1
  return false
}

/** wheel 落在消息内部的可滚动块（工具输出 pre、房间选择列表、草稿卡等）上时，
 * 手势属于内层容器：内层能吃下这段位移就不该改写外层的吸底状态。 */
export function isNestedScrollerWheel(
  target: EventTarget | null,
  boundary: HTMLElement,
  deltaY: number,
): boolean {
  if (deltaY === 0) return false
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false
  let node: Element | null = target
  while (node && node !== boundary) {
    if (canConsumeVerticalScroll(node, deltaY)) return true
    node = node.parentElement
  }
  return false
}

function canConsumeVerticalScroll(element: Element, deltaY: number): boolean {
  if (typeof HTMLElement === 'undefined' || !(element instanceof HTMLElement)) return false
  const view = element.ownerDocument?.defaultView
  return canConsumeVerticalWheel({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    overflowY: view?.getComputedStyle(element).overflowY,
  }, deltaY)
}

export function isScrolledToBottom(
  element: HTMLElement,
  threshold: number = AGENT_CHAT_PIN_THRESHOLD_PX,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
}

/** 下滚追赶带上限：触控板惯性单次位移可达数百像素，上限内不吸底防磁吸复发。 */
export const AGENT_CHAT_WHEEL_CHASE_MAX_PX = 400

/**
 * 下滚回吸的追赶带宽度。流式爆发（整段工具结果/长思考一次插入，数百上千像素）时
 * 底部跑得比滚轮快，固定 32px 阈值在用户明确向下滚时也永远追不上（2026-11-05 实测
 * 「生成进行中滑不到底」）。带宽随本次滚轮位移放款：强甩到接近底部即视为想跟回；
 * 轻滚（小 deltaY）仍是原 32px，历史上的宽阈值磁吸/回弹问题不会复发（旧问题是
 * 静态内容 + 固定 160px 宽带；这里是位移比例带，只对高速下滚放宽）。
 */
export function wheelDownChaseBand(deltaY: number): number {
  const distance = Math.abs(deltaY)
  return Math.min(AGENT_CHAT_WHEEL_CHASE_MAX_PX, Math.max(AGENT_CHAT_REPIN_DISTANCE_PX, distance * 3))
}
