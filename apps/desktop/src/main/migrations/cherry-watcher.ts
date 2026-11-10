import { existsSync, type FSWatcher, watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { cherryDataRoot, detectCherryStore } from './cherry-adapter'

const QUIET_WINDOW_MS = 8_000
const MIN_ROUND_INTERVAL_MS = 60_000
const STARTUP_DELAY_MS = 15_000

export interface CherrySyncCheckpoint {
  fingerprint: string
  dbMtimeMs: number
  dbSize: number
  confirmedAt: number
}

export interface CherryWatcherCallbacks {
  /** 一轮增量导入（由 coordinator 提供，内部走 readCherrySource → begin/threads/finish(false)）。 */
  runRound: () => Promise<{ fingerprint: string }>
  /** 不可恢复错误（格式不支持、目录消失等）：watcher 自动停摆。 */
  onFatal: (error: string) => void
  /** 每轮结果上报（供能力状态/日志）。 */
  onRound?: (result: { skipped: boolean; fingerprint: string }) => void
  loadCheckpoint: () => CherrySyncCheckpoint | null
  saveCheckpoint: (checkpoint: CherrySyncCheckpoint) => void
}

/**
 * Cherry Studio 数据目录监听：写活动静默 8s 后触发一轮增量，最小间隔 60s 强制兜底。
 * 每轮开始先做零成本检查——数据库文件 mtime+size 与已确认检查点一致即整轮跳过（零解析）。
 * 检查点在每轮成功后推进；中断后重启按检查点跳过未变化数据，变化数据靠幂等 upsert 收敛。
 */
export class CherryWatcher {
  private watcher: FSWatcher | null = null
  private quietTimer: NodeJS.Timeout | null = null
  private minIntervalTimer: NodeJS.Timeout | null = null
  private running = false
  private lastRoundAt = 0
  private stopped = true

  constructor(
    private readonly root: string = cherryDataRoot(),
    private readonly callbacks: CherryWatcherCallbacks,
    private readonly quietMs: number = QUIET_WINDOW_MS,
    private readonly minIntervalMs: number = MIN_ROUND_INTERVAL_MS,
  ) {}

  get active(): boolean { return !this.stopped }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    if (!existsSync(this.root)) { this.callbacks.onFatal('cherry_source_not_found'); this.stopped = true; return }
    try {
      this.watcher = watch(this.root, { recursive: true }, () => this.scheduleQuietRound())
    } catch {
      this.callbacks.onFatal('cherry_watch_failed')
      this.stopped = true
      return
    }
    this.watcher.once('error', () => { this.callbacks.onFatal('cherry_watch_failed'); this.stop() })
    // 启动延迟：避开 Cherry 启动期的批量写入，之后触发首轮（也覆盖应用启动时的新数据）。
    const startup = setTimeout(() => { this.startupTimer = null; this.scheduleRound(true) }, STARTUP_DELAY_MS)
    startup.unref?.()
    this.startupTimer = startup
    this.minIntervalTimer = setInterval(() => { this.scheduleRound(true) }, this.minIntervalMs)
    this.minIntervalTimer.unref?.()
  }

  private startupTimer: NodeJS.Timeout | null = null

  stop(): void {
    this.stopped = true
    this.watcher?.close(); this.watcher = null
    if (this.quietTimer) { clearTimeout(this.quietTimer); this.quietTimer = null }
    if (this.minIntervalTimer) { clearInterval(this.minIntervalTimer); this.minIntervalTimer = null }
    if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = null }
  }

  /** 立即尝试一轮（受最小间隔与运行中互斥约束）；watcher 未启动时为 no-op。 */
  async syncNow(): Promise<void> { await this.round() }

  private scheduleQuietRound(): void {
    if (this.stopped) return
    if (this.quietTimer) clearTimeout(this.quietTimer)
    const timer = setTimeout(() => { this.quietTimer = null; void this.round() }, this.quietMs)
    timer.unref?.()
    this.quietTimer = timer
  }

  private scheduleRound(force: boolean): void {
    if (this.stopped) return
    if (force) void this.round()
    else this.scheduleQuietRound()
  }

  private async round(): Promise<void> {
    if (this.stopped || this.running) return
    if (Date.now() - this.lastRoundAt < this.minIntervalMs && this.lastRoundAt > 0) return
    this.running = true
    try {
      const info = detectCherryStore(this.root)
      if (!info) { this.callbacks.onFatal('cherry_source_not_found'); this.stop(); return }
      const checkpoint = this.callbacks.loadCheckpoint()
      if (checkpoint && checkpoint.fingerprint === info.fingerprint) {
        const dbStat = await stat(info.dbPath).catch(() => null)
        if (dbStat && dbStat.mtimeMs === checkpoint.dbMtimeMs && dbStat.size === checkpoint.dbSize) {
          this.lastRoundAt = Date.now()
          this.callbacks.onRound?.({ skipped: true, fingerprint: info.fingerprint })
          return
        }
      }
      const result = await this.callbacks.runRound()
      const dbStat = await stat(info.dbPath).catch(() => null)
      if (dbStat) {
        this.callbacks.saveCheckpoint({ fingerprint: result.fingerprint, dbMtimeMs: dbStat.mtimeMs, dbSize: dbStat.size, confirmedAt: Date.now() })
      }
      this.lastRoundAt = Date.now()
      this.callbacks.onRound?.({ skipped: false, fingerprint: result.fingerprint })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'cherry_format_unsupported') {
        this.callbacks.onFatal(message)
        this.stop()
        return
      }
      // 轮内错误不杀 watcher：下一轮重试，幂等 upsert 保证收敛。
      this.lastRoundAt = Date.now()
      this.callbacks.onRound?.({ skipped: false, fingerprint: '' })
    } finally {
      this.running = false
    }
  }
}
