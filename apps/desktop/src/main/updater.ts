import { app, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { SaasClient } from './cloud/saas-client'

type UpdateChannel = 'stable' | 'nightly'

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** 渠道由环境变量切换（打包场景走 packaged-env），默认 stable。 */
function currentChannel(): UpdateChannel {
  return process.env.NXCORE_UPDATE_CHANNEL === 'nightly' ? 'nightly' : 'stable'
}

/** OSS 直链备源：控制面不可用时无灰度兜底，未配置则跳过降级。 */
function fallbackFeedUrl(): string | null {
  return process.env.NXCORE_UPDATE_FALLBACK_URL ?? null
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const pb = b.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

/** installId 优先用登录设备 ID（管理台统计可关联设备），未登录则本地持久化匿名 ID。 */
async function resolveInstallId(saasClient: SaasClient | null): Promise<string> {
  const deviceId = saasClient?.deviceId
  if (deviceId) return deviceId
  const file = join(app.getPath('userData'), 'update-install-id')
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing) return existing
  }
  const generated = randomUUID()
  writeFileSync(file, generated, 'utf8')
  return generated
}

export class DesktopUpdater {
  private readonly channel: UpdateChannel
  private readonly feedUrl: string
  private readonly reportUrl: string
  private installId = ''
  private reportedVersion = ''
  private usingFallback = false
  private manualChecking = false

  constructor(private readonly saasClient: SaasClient | null) {
    this.channel = currentChannel()
    const base = (saasClient?.baseUrl ?? 'https://api.everroom.vyitec.com/api/v1').replace(/\/+$/, '')
    this.feedUrl = `${base}/app/feed`
    this.reportUrl = `${base}/app/update-report`
  }

  async start(): Promise<void> {
    this.installId = await resolveInstallId(this.saasClient)
    // IPC 两种模式都注册：dev 下按钮可点（supported=false，返回错误态），打包版才有真实更新链路
    this.registerIpc()
    if (!app.isPackaged) return
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = this.channel === 'nightly'
    autoUpdater.logger = console
    this.applyFeed()
    autoUpdater.on('checking-for-update', () => void this.report('check'))
    autoUpdater.on('update-downloaded', info => {
      void this.report('downloaded', info.version)
      void this.promptInstall(info)
    })
    autoUpdater.on('error', () => void this.tryFallbackOnce())
    setTimeout(() => void this.check(), 5000)
    setInterval(() => void this.check(), UPDATE_CHECK_INTERVAL_MS)
  }

  /** 设置页「检查更新」按钮：与后台轮询共用下载与弹窗链路。 */
  async checkNow(): Promise<'update-found' | 'no-update' | 'busy' | 'error'> {
    if (this.manualChecking) return 'busy'
    this.manualChecking = true
    try {
      const result = await autoUpdater.checkForUpdates()
      return result?.versionInfo ? 'update-found' : 'no-update'
    } catch {
      return 'error'
    } finally {
      this.manualChecking = false
    }
  }

  getStatus() {
    return { version: app.getVersion(), channel: this.channel, installId: this.installId, supported: app.isPackaged }
  }

  private registerIpc(): void {
    ipcMain.handle('update:get-status', () => this.getStatus())
    ipcMain.handle('update:check-now', () => this.checkNow())
  }

  private applyFeed(url?: string): void {
    const target = url ?? `${this.feedUrl}/${this.channel}/${this.installId}`
    autoUpdater.setFeedURL({ provider: 'generic', url: target, useMultipleRangeRequest: false })
  }

  private async check(): Promise<void> {
    try { await autoUpdater.checkForUpdates() } catch { /* 降级逻辑走 error 事件；此处静默 */ }
  }

  /** 主源失败切 OSS 直链备源再试一次；已在备源则放弃本轮。 */
  private async tryFallbackOnce(): Promise<void> {
    const fallback = fallbackFeedUrl()
    if (this.usingFallback || !fallback) return
    this.usingFallback = true
    this.applyFeed(fallback)
    await this.check()
  }

  private async promptInstall(info: UpdateInfo): Promise<void> {
    // 强更：当前版本低于服务端 minVersion 门槛时仅允许立即更新或退出
    const minVersion = (info as UpdateInfo & { minVersion?: string }).minVersion
    if (minVersion && compareVersions(app.getVersion(), minVersion) < 0) {
      const choice = await dialog.showMessageBox({
        type: 'warning',
        title: '必须更新',
        message: `当前版本 ${app.getVersion()} 过旧，需要更新到 ${info.version} 后才能继续使用。`,
        buttons: ['立即重启更新', '退出'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (choice.response === 0) { void this.report('installed', info.version); autoUpdater.quitAndInstall() }
      else app.quit()
      return
    }
    const choice = await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `新版本 ${info.version} 已就绪。`,
      detail: '重启后立即生效，也可以下次启动时自动安装。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (choice.response === 0) { void this.report('installed', info.version); autoUpdater.quitAndInstall() }
  }

  private async report(event: 'check' | 'downloaded' | 'installed' | 'error', version?: string): Promise<void> {
    const target = version ?? app.getVersion()
    // check 事件高频（每次轮询），同一版本只上报一次，避免刷统计
    if (event === 'check' && this.reportedVersion === target) return
    this.reportedVersion = target
    void fetch(this.reportUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installId: this.installId, version: target, channel: this.channel, event }),
    }).catch(() => {})
  }
}

/** 装配入口：在 saasClient 创建之后调用，异步自启，不阻塞窗口。 */
export function startDesktopUpdater(saasClient: SaasClient | null): void {
  void new DesktopUpdater(saasClient).start().catch(error => console.warn('[updater] 启动失败', error))
}
