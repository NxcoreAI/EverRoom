// 屏幕记忆观察区间状态机：首帧开区间，应用切换/锁屏/休眠/空闲/越界/暂停关区间。

export type IntervalEndReason =
  | 'app-switch'
  | 'lock'
  | 'suspend'
  | 'idle'
  | 'out-of-scope'
  | 'paused'
  | 'stopped'

export interface KeyframeRecord {
  capturedAt: Date
  imagePath: string
  imageBytes: number
  perceptualHash: string
  width: number
  height: number
  lineCount: number
  elapsedMs: number
}

export interface ClosedInterval {
  bundleId: string
  appName: string
  windowTitle: string | null
  title: string
  startedAt: Date
  endedAt: Date
  endReason: IntervalEndReason
  keyframes: KeyframeRecord[]
  textLines: string[]
  textBlocks: string[]
}

interface OpenIntervalState {
  bundleId: string
  appName: string
  windowTitle: string | null
  startedAt: Date
  lastEndedAt: Date
  keyframes: KeyframeRecord[]
  textSet: Set<string>
  textLines: string[]
  textBlockSet: Set<string>
  textBlocks: string[]
  stableLines: string[]
}

export interface IntervalTrackerEvents {
  onIntervalClosed: (interval: ClosedInterval) => void
}

export class IntervalTracker {
  private open: OpenIntervalState | null = null

  constructor(private readonly events: IntervalTrackerEvents) {}

  get currentApp(): string | null {
    return this.open?.bundleId ?? null
  }

  get openInterval(): boolean {
    return this.open !== null
  }

  /** 当前区间上一关键帧的稳定行，供下一帧差异比对；无区间时为空。 */
  lastStableLines(): string[] {
    return this.open ? this.open.stableLines : []
  }

  /** 应用切换：关闭旧区间（若有），新区间由下一帧开启。 */
  appSwitched(now: Date): ClosedInterval | null {
    return this.close('app-switch', now)
  }

  systemEvent(reason: Extract<IntervalEndReason, 'lock' | 'suspend' | 'idle'>, now: Date): ClosedInterval | null {
    return this.close(reason, now)
  }

  paused(now: Date): ClosedInterval | null {
    return this.close('paused', now)
  }

  stop(now: Date): ClosedInterval | null {
    return this.close('stopped', now)
  }

  /**
   * 收到一帧已判定为「内容有变化」的关键帧。首帧开区间。
   * stableLines 供下一帧差异比对，newLines 并入区间文本，
   * newBlocks（含新行的文本块）并入区间文本块。
   */
  acceptKeyframe(input: {
    now: Date
    bundleId: string
    appName: string
    windowTitle: string | null
    keyframe: KeyframeRecord
    stableLines: string[]
    newLines: string[]
    newBlocks: string[]
  }): void {
    if (this.open && this.open.bundleId !== input.bundleId) {
      this.close('app-switch', input.now)
    }
    if (!this.open) {
      this.open = {
        bundleId: input.bundleId,
        appName: input.appName,
        windowTitle: input.windowTitle,
        startedAt: input.now,
        lastEndedAt: input.now,
        keyframes: [],
        textSet: new Set<string>(),
        textLines: [],
        textBlockSet: new Set<string>(),
        textBlocks: [],
        stableLines: [],
      }
    }
    this.open.windowTitle = this.open.windowTitle ?? input.windowTitle
    this.open.lastEndedAt = input.now
    this.open.keyframes.push(input.keyframe)
    this.open.stableLines = input.stableLines
    for (const line of input.newLines) {
      const key = line.replace(/\s+/g, '').toLowerCase()
      if (this.open.textSet.has(key)) continue
      this.open.textSet.add(key)
      this.open.textLines.push(line)
    }
    for (const block of input.newBlocks) {
      const key = block.replace(/\s+/g, '').toLowerCase()
      if (this.open.textBlockSet.has(key)) continue
      this.open.textBlockSet.add(key)
      this.open.textBlocks.push(block)
    }
  }

  /** 无变化心跳：区间仍在观察中，延长结束时间。 */
  heartbeat(now: Date): void {
    if (this.open) this.open.lastEndedAt = now
  }

  private close(reason: IntervalEndReason, now: Date): ClosedInterval | null {
    const open = this.open
    this.open = null
    if (!open) return null
    const endedAt = reason === 'idle' || reason === 'suspend' || reason === 'lock' ? now : open.lastEndedAt
    const interval: ClosedInterval = {
      bundleId: open.bundleId,
      appName: open.appName,
      windowTitle: open.windowTitle,
      title: deriveTitle(open),
      startedAt: open.startedAt,
      endedAt: new Date(Math.max(open.startedAt.getTime(), endedAt.getTime())),
      endReason: reason,
      keyframes: open.keyframes,
      textLines: open.textLines,
      textBlocks: open.textBlocks,
    }
    this.events.onIntervalClosed(interval)
    return interval
  }
}

function deriveTitle(open: OpenIntervalState): string {
  if (open.windowTitle && open.windowTitle.trim().length > 0) return open.windowTitle.trim().slice(0, 120)
  const first = open.textLines[0]
  if (first) return first.slice(0, 120)
  return open.appName
}
