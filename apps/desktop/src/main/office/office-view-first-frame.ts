import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'

import { logOfficeDiag } from './office-diag'

/** 首帧兜底：页面迟迟不来 dom-ready（坏文件/加载挂住）也要把视图显示出来。 */
const FIRST_FRAME_FAILSAFE_MS = 4_000
/** 首次显示后的几何校准延迟：让合成器拿到新几何再重绘一帧。 */
const FIRST_FRAME_SETTLE_MS = 32

/**
 * 内嵌 Office 原生视图的「首次出帧」闸门。
 *
 * 背景：`WebContentsView` 创建后、页面提交首帧前就 `setVisible(true)` 时，
 * Chromium（Electron 40 一系）可能一直不给出这一帧——视图的 visible/bounds
 * 都对，但合成器没有内容，宿主 DOM 里「Office 预览」的兜底占位会整块透出来，
 * 切页隐藏再显示才恢复。访达直接打开文档时视图恰好是「新建即显示」，所以最
 * 容易撞上；已打开过的文档复用同一个视图，自然看不到。
 *
 * 处理：
 * 1. 首次显示推迟到 `dom-ready`（首帧已提交）；页面加载失败也放行，交给视图
 *    自己的错误态；另有 4s 兜底，避免一直不显示。
 * 2. 首次真正显示后做一次 1px 几何变更再还原，逼合成器重新布局并出帧。
 * 3. 显示时主窗口不在前台，则等窗口 `focus` 后再补一次显隐/几何，覆盖
 *    「访达打开、应用还没真正到前台」的时序。
 */
export class OfficeViewFirstFrameGate {
  private active = false
  private bounds: Rectangle | null = null
  private ready = false
  private shownOnce = false
  private disposed = false
  private settleTimer: NodeJS.Timeout | null = null
  private failsafeTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly view: WebContentsView,
    private readonly window: BrowserWindow,
  ) {
    const contents = view.webContents
    const markReady = (source: string) => this.markReady(source)
    contents.once('dom-ready', () => markReady('dom-ready'))
    // 主框架加载失败也要放行：视图自己的错误态/空文档至少比宿主占位更接近真实。
    // 用 on 而不是 once：先到的子框架失败不该把监听消耗掉。
    contents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame !== false) markReady('did-fail-load')
    })
    contents.once('destroyed', () => this.dispose())
    window.on('focus', this.handleWindowFocus)
    this.failsafeTimer = setTimeout(() => markReady('failsafe'), FIRST_FRAME_FAILSAFE_MS)
    this.failsafeTimer.unref?.()
  }

  setActive(active: boolean): void {
    this.active = active
    this.sync('set-active')
  }

  setBounds(bounds: Rectangle): void {
    this.bounds = bounds
    if (this.alive) this.view.setBounds(bounds)
    this.sync('set-bounds')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.settleTimer) clearTimeout(this.settleTimer)
    if (this.failsafeTimer) clearTimeout(this.failsafeTimer)
    this.settleTimer = null
    this.failsafeTimer = null
    if (!this.window.isDestroyed()) this.window.removeListener('focus', this.handleWindowFocus)
  }

  private get alive(): boolean {
    return !this.disposed && !this.window.isDestroyed() && !this.view.webContents.isDestroyed()
  }

  private markReady(source: string): void {
    if (this.disposed || this.ready) return
    this.ready = true
    if (this.failsafeTimer) clearTimeout(this.failsafeTimer)
    this.failsafeTimer = null
    logOfficeDiag('office.diag.first-frame.ready', { source, active: this.active, bounds: this.bounds })
    this.sync('ready')
  }

  private readonly handleWindowFocus = (): void => {
    if (!this.alive || !this.active || !this.shownOnce) return
    this.view.setVisible(true)
    if (this.bounds) this.view.setBounds(this.bounds)
  }

  private sync(reason: string): void {
    if (!this.alive) return
    const bounds = this.bounds
    const visible = this.active && this.ready && Boolean(bounds && bounds.width > 0 && bounds.height > 0)
    if (!visible) {
      this.view.setVisible(false)
      return
    }
    this.view.setVisible(true)
    if (this.shownOnce) return
    this.shownOnce = true
    logOfficeDiag('office.diag.first-frame.show', {
      reason,
      bounds,
      windowFocused: this.window.isFocused(),
      windowVisible: this.window.isVisible(),
    })
    // 首次显示：先把宽度改 1px 再还原，制造一次真实的几何变更。
    const target = bounds!
    this.view.setBounds({ x: target.x, y: target.y, width: Math.max(1, target.width - 1), height: target.height })
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      if (!this.alive || !this.active || !this.bounds) return
      this.view.setBounds(this.bounds)
      this.view.setVisible(true)
    }, FIRST_FRAME_SETTLE_MS)
  }
}
