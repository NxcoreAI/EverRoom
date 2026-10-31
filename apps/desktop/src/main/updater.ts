import { app, dialog, ipcMain, webContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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

function pendingUpdateFile(): string {
  return join(app.getPath('userData'), PENDING_UPDATE_FILE)
}

function readPendingUpdate(): PendingUpdateRecord | null {
  try {
    if (!existsSync(pendingUpdateFile())) return null
    const raw = JSON.parse(readFileSync(pendingUpdateFile(), 'utf8')) as Partial<PendingUpdateRecord>
    if (typeof raw.from !== 'string' || typeof raw.to !== 'string' || typeof raw.at !== 'string') return null
    return { from: raw.from, to: raw.to, at: raw.at }
  } catch {
    return null
  }
}

function writePendingUpdate(record: PendingUpdateRecord): void {
  try {
    writeFileSync(pendingUpdateFile(), JSON.stringify(record), 'utf8')
  } catch (error) {
    console.warn('[updater] 写入待核验标记失败', error)
  }
}

function clearPendingUpdate(): void {
  try {
    if (existsSync(pendingUpdateFile())) unlinkSync(pendingUpdateFile())
  } catch (error) {
    console.warn('[updater] 清理待核验标记失败', error)
  }
}

/** 渠道暂无版本时 feed 返回 404——业务正常态，非故障。 */
function isFeedNotFound(error: unknown): boolean {
  const status = (error as { statusCode?: number }).statusCode
  const message = error instanceof Error ? error.message : ''
  return status === 404 || /\b404\b|not found/i.test(message)
}

interface PendingUpdateRecord {
  from: string
  to: string
  at: string
}

/**
 * 「待核验更新」标记：点「立即重启」前写入，重启后核验版本是否真的变了。
 * 这是打破「提示→重启→再提示」循环的关键——安装器静默失败（文件被占用、
 * 权限不足、磁盘满）时，重启后版本没变，没有这个标记就只能无限重弹提示。
 */
const PENDING_UPDATE_FILE = 'update-pending.json'

export class DesktopUpdater {
  private readonly channel: UpdateChannel
  private readonly feedUrl: string
  private readonly reportUrl: string
  private installId = ''
  private reportedVersion = ''
  private usingFallback = false
  private manualChecking = false
  /** 最近一次更新链路错误（设置页展示用），feed 404 不算。 */
  private lastError: string | null = null

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
    // nightly 包内烙完整版本（CI extraMetadata.version），currentVersion 与 feed 版本
    // 可直接相等/比较；此处显式允许 prerelease 比较仅作兜底，不启用 allowDowngrade——
    // 裸版本设备遇 feed 里的 -nightly.N 会被判"更旧"，开启即陷入永久重提示循环。
    autoUpdater.allowPrerelease = this.channel === 'nightly'
    autoUpdater.logger = console
    this.applyFeed()
    // 先核验上一次「点了立即重启」的结果：成功补真上报，失败明确弹窗。
    // 必须在首次 check 之前做，否则旧提示会立刻再弹一次。
    await this.verifyPendingUpdate()
    autoUpdater.on('checking-for-update', () => void this.report('check'))
    autoUpdater.on('download-progress', progress => {
      // 广播给所有窗口：设置页显示百分比与实时速度
      for (const wc of webContents.getAllWebContents()) {
        wc.send('update:progress', { percent: progress.percent, bytesPerSecond: progress.bytesPerSecond })
      }
    })
    autoUpdater.on('update-downloaded', info => {
      for (const wc of webContents.getAllWebContents()) wc.send('update:downloaded', { version: info.version })
      void this.report('downloaded', info.version)
      void this.promptInstall(info)
    })
    autoUpdater.on('error', error => {
      // 404 = 渠道暂无版本，属正常业务态：不切备源、不产生降级副作用
      if (isFeedNotFound(error)) return
      // 更新链路任何失败（检查/下载/校验/安装）都要可见：广播给设置页 + 上报。
      // 此前错误被静默吞掉，下载失败时界面永远停在「正在后台下载」。
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message
      for (const wc of webContents.getAllWebContents()) {
        wc.send('update:error', { message })
      }
      void this.report('error')
      void this.tryFallbackOnce()
    })
    setTimeout(() => void this.check(), 5000)
    setInterval(() => void this.check(), UPDATE_CHECK_INTERVAL_MS)
  }

  /** 设置页「检查更新」按钮：与后台轮询共用下载与弹窗链路。 */
  async checkNow(): Promise<'update-found' | 'no-update' | 'busy' | 'error'> {
    if (this.manualChecking) return 'busy'
    this.manualChecking = true
    try {
      const result = await autoUpdater.checkForUpdates()
      // versionInfo 无更新时也存在（=当前版本），必须用 isUpdateAvailable 判断，
      // 否则渠道内最高版=当前版时误报「发现新版本」
      this.lastError = null
      return result?.isUpdateAvailable ? 'update-found' : 'no-update'
    } catch (error) {
      if (isFeedNotFound(error)) return 'no-update'
      this.lastError = error instanceof Error ? error.message : String(error)
      return 'error'
    } finally {
      this.manualChecking = false
    }
  }

  getStatus() {
    return {
      version: app.getVersion(),
      channel: this.channel,
      installId: this.installId,
      supported: app.isPackaged,
      lastError: this.lastError,
    }
  }

  private registerIpc(): void {
    ipcMain.handle('update:get-status', () => this.getStatus())
    ipcMain.handle('update:check-now', () => this.checkNow())
  }

  private applyFeed(url?: string): void {
    const target = url ?? `${this.feedUrl}/${this.channel}/${this.installId}`
    // OSS 支持 Range 并发（多段下载提速）；不关 useMultipleRangeRequest
    autoUpdater.setFeedURL({ provider: 'generic', url: target })
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

  /**
   * 重启后核验上一次更新：
   * - 版本已变 → 安装成功：清标记，补一次真实的 installed 上报（替换旧的提前上报）。
   * - 版本没变 → 安装失败（安装器被占用/权限不足/磁盘满等）：清标记 + 强提示 + 失败上报，
   *   不让「提示→重启→再提示」循环无感地进行。
   */
  private async verifyPendingUpdate(): Promise<void> {
    const pending = readPendingUpdate()
    if (!pending) return
    clearPendingUpdate()
    const current = app.getVersion()
    if (compareVersions(current, pending.to) >= 0) {
      // 升级成功（或已≥目标版本）：此刻才补真实上报
      void this.report('installed', current)
      console.info(`[updater] 更新生效：${pending.from} → ${current}`)
      return
    }
    const detail = [
      `目标版本 ${pending.to} 未生效，当前仍是 ${current}。`,
      '常见原因：安装包被安全软件拦截、安装目录权限不足或磁盘空间不足。',
    ].join('\n')
    void this.report('error', pending.to)
    await dialog.showMessageBox({
      type: 'error',
      title: '更新未完成',
      message: `上一次更新到 ${pending.to} 没有生效`,
      detail,
      buttons: ['知道了'],
      noLink: true,
    })
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
      if (choice.response === 0) this.installNow(info)
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
    if (choice.response === 0) this.installNow(info)
  }

  /**
   * 静默安装并自动重启：quitAndInstall(true, true) = /S --force-run。
   * 此前无参调用是非静默模式：安装器以交互向导启动，而 before-quit 里
   * preventDefault + 异步关停 10 个服务，安装器等不到进程退出 → 文件被占用 →
   * 升级替换失败 → 重启后版本没变 → 再次弹更新提示（死循环根因）。
   */
  private installNow(info: UpdateInfo): void {
    // 标记先写：重启后 verifyPendingUpdate 据此核验版本是否真的变了。
    writePendingUpdate({ from: app.getVersion(), to: info.version, at: new Date().toISOString() })
    // 注意：不能再用无参调用——非静默模式安装器以交互向导启动，且 async spawn 后
    // 才退出应用，与 before-quit 的异步关停（10 个服务）互相踩踏导致安装失败。
    autoUpdater.quitAndInstall(true, true)
    // 兜底：静默安装器未能启动（返回 false 只走 error 事件）或进程没退成，
    // 3s 后还在运行 = 本次重启更新失败 —— 清标记并广播错误，用户可重试。
    const timer = setTimeout(() => {
      clearPendingUpdate()
      this.lastError = '安装程序未能启动，应用未能退出更新。请关闭其他窗口后重试。'
      for (const wc of webContents.getAllWebContents()) {
        wc.send('update:error', { message: this.lastError })
      }
      void this.report('error')
    }, 3000)
    // 应用真的退出时 timer 不会触发（进程终止）；unref 防止 timer 挡住退出。
    timer.unref?.()
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
