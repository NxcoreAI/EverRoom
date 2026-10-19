/**
 * 内嵌 Office 视口协调：原生 WebContentsView 永远画在 DOM 之上，z-index
 * 管不了它，只能靠「矩形上报 + 显隐时序」对齐。本模块把时序规则集中到一处：
 * 1. 卸载（detach）立即上报零尺寸：页签/页面切换当帧隐藏，消灭残影遮蔽。
 * 2. 挂载后双帧确认布局再首次上报，且先做遮挡扫描，避免在弹框下闪现。
 * 3. 宿主矩形归零（面板收起等）同样上报零尺寸隐藏，而不是保留旧矩形。
 * 4. 祖先滚动会移动矩形而不改尺寸：捕获阶段 scroll 一并重报。
 * 5. 遮挡扫描：对宿主 5 个采样点做 elementsFromPoint 命中测试，多数点被
 *    其他元素盖住（全屏弹框/命令面板/拖拽层）→ 上报零尺寸隐藏；撤掉后
 *    恢复真实矩形。由 body 变更（防抖）与 pointerdown/focusin 触发。
 */
export interface OfficeViewportAttachment {
  detach(): void
}

interface OfficeViewportBounds {
  x: number
  y: number
  width: number
  height: number
}

const OCCLUSION_HIDE_THRESHOLD = 3
const SCAN_QUIET_MS = 150
const CORNER_INSET = 4
const ZERO_BOUNDS: OfficeViewportBounds = { x: 0, y: 0, width: 0, height: 0 }

function sendBounds(bounds: OfficeViewportBounds): void {
  window.nxcore?.office?.setWorkspaceBounds(bounds)
}

/** 采样点被盖住 = 命中栈顶既不是宿主、不在宿主内、也不包含宿主。 */
function isPointOccluded(host: HTMLElement, x: number, y: number): boolean {
  if (typeof document.elementsFromPoint !== 'function') return false
  const top = document.elementsFromPoint(x, y)[0]
  if (!top || top === host) return false
  return !host.contains(top) && !top.contains(host)
}

function countOccludedSamples(host: HTMLElement): number {
  const rect = host.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return 0
  const midX = rect.left + rect.width / 2
  const midY = rect.top + rect.height / 2
  const left = rect.left + CORNER_INSET
  const right = rect.right - CORNER_INSET
  const top = rect.top + CORNER_INSET
  const bottom = rect.bottom - CORNER_INSET
  const points: Array<[number, number]> = [
    [midX, midY],
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ]
  let occluded = 0
  for (const [x, y] of points) {
    if (isPointOccluded(host, x, y)) occluded += 1
  }
  return occluded
}

export function attachOfficeViewport(host: HTMLElement): OfficeViewportAttachment {
  let detached = false
  let suppressed = false
  let scanTimer: number | null = null

  const report = (): void => {
    if (detached || suppressed) return
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      sendBounds(ZERO_BOUNDS)
      return
    }
    sendBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
  }

  const scan = (): void => {
    if (detached) return
    const next = countOccludedSamples(host) >= OCCLUSION_HIDE_THRESHOLD
    if (next === suppressed) return
    suppressed = next
    if (suppressed) sendBounds(ZERO_BOUNDS)
    else report()
  }

  // 首次立即扫（弹层出现当帧判定），静默 150ms 后再扫一次收尾（动画类关闭）。
  const scheduleScan = (): void => {
    if (detached) return
    if (scanTimer === null) scan()
    else window.clearTimeout(scanTimer)
    scanTimer = window.setTimeout(() => {
      scanTimer = null
      scan()
    }, SCAN_QUIET_MS)
  }

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(report) : null
  observer?.observe(host)
  const mutationObserver = typeof MutationObserver === 'function' && document.body
    ? new MutationObserver(scheduleScan)
    : null
  mutationObserver?.observe(document.body!, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  })
  window.addEventListener('resize', report)
  window.addEventListener('scroll', report, true)
  window.addEventListener('pointerdown', scheduleScan, true)
  window.addEventListener('focusin', scheduleScan, true)

  const nextFrame = (callback: () => void): void => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback)
    else callback()
  }
  nextFrame(() => nextFrame(() => {
    scan()
    report()
  }))

  return {
    detach(): void {
      if (detached) return
      detached = true
      if (scanTimer !== null) {
        window.clearTimeout(scanTimer)
        scanTimer = null
      }
      observer?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', report)
      window.removeEventListener('scroll', report, true)
      window.removeEventListener('pointerdown', scheduleScan, true)
      window.removeEventListener('focusin', scheduleScan, true)
      sendBounds(ZERO_BOUNDS)
    },
  }
}
