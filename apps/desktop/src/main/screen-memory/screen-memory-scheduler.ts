import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { calculateDHash } from '../screenshot/window-screenshot-service'
import { diffKeyframeText } from './text-diff'
import { blocksWithNewLines, clusterOcrLines } from './line-clustering'
import { IntervalTracker, type ClosedInterval } from './interval-tracker'
import { isAppInScope, getScreenMemoryImagesDirectory, type ScreenMemorySettings } from './screen-memory-settings'
import type { CaptureScreen, ScreenPermissionStatus } from './capture-current-screen'
import type { VisionFrontmostInfo, VisionOcrResult } from '../vision-ocr/vision-ocr-client'
import type { PowerEventKind, PowerWatcher } from './power-watcher'

export const HEARTBEAT_LADDER_MS = [30_000, 60_000, 120_000, 300_000] as const
const QUIET_BEATS_BEFORE_STEP_UP = 2
const RAW_JPEG_QUALITY = 82

export interface ScreenMemoryIntervalPersistence {
  saveInterval(interval: ClosedInterval): Promise<void>
}

export interface ScreenMemorySchedulerStatus {
  running: boolean
  permission: ScreenPermissionStatus
  helperAvailable: boolean
  paused: boolean
  enabled: boolean
  currentBundleId: string | null
  currentAppName: string | null
  openIntervalSince: string | null
  currentKeyframes: number
  heartbeatMs: number
  lastBeatAt: string | null
  lastError: string | null
}

export interface ScreenMemorySchedulerDeps {
  ocr: {
    frontmost(): Promise<VisionFrontmostInfo>
    ocr(imagePath: string, options?: { level?: 'accurate' | 'fast'; compressOut?: string }): Promise<VisionOcrResult>
  }
  capture: CaptureScreen
  settings: () => ScreenMemorySettings
  persist: ScreenMemoryIntervalPersistence
  permission: () => ScreenPermissionStatus
  watchPower: (onEvent: (kind: PowerEventKind, at: Date) => void) => PowerWatcher
  baseDirectory: string
  timerApi?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>
  now?: () => Date
  onError?: (message: string) => void
}

export interface ScreenMemoryScheduler {
  start(): Promise<void>
  stop(): Promise<void>
  beat(): Promise<void>
  status(): ScreenMemorySchedulerStatus
}

export function createScreenMemoryScheduler(deps: ScreenMemorySchedulerDeps): ScreenMemoryScheduler {
  const timerApi = deps.timerApi ?? globalThis
  const now = deps.now ?? (() => new Date())
  const tracker = new IntervalTracker({
    onIntervalClosed: (interval) => {
      void deps.persist.saveInterval(interval).catch((error: unknown) => {
        reportError(`screen-memory interval save failed: ${String(error instanceof Error ? error.message : error)}`)
      })
    },
  })

  let running = false
  let timer: ReturnType<typeof timerApi.setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let ladderIndex = 0
  let quietStreak = 0
  let powerWatcher: PowerWatcher | null = null
  let lastBeatAt: Date | null = null
  let lastError: string | null = null
  let openSince: Date | null = null
  let currentAppName: string | null = null
  let keyframeCount = 0
  let helperAvailable = true

  const reportError = (message: string) => {
    lastError = message
    deps.onError?.(message)
  }

  const inboxDirectory = join(deps.baseDirectory, 'inbox')

  const ensureDirectories = async () => {
    await mkdir(inboxDirectory, { recursive: true })
  }

  const imagesDirectoryFor = (at: Date): string => {
    const year = at.getFullYear()
    const month = String(at.getMonth() + 1).padStart(2, '0')
    return join(getScreenMemoryImagesDirectory(deps.baseDirectory), `${String(year)}-${month}`)
  }

  const scheduleNext = (delayMs: number) => {
    if (!running || timer || inFlight) return
    timer = timerApi.setTimeout(() => {
      timer = null
      inFlight = runBeat()
      void inFlight
    }, delayMs)
  }

  const runBeat = async (): Promise<void> => {
    if (!running) return
    try {
      await beat()
    } finally {
      inFlight = null
      if (running) scheduleNext(currentHeartbeatMs())
    }
  }

  const currentHeartbeatMs = (): number => HEARTBEAT_LADDER_MS[ladderIndex]!

  const stepUpLadder = () => {
    if (quietStreak >= QUIET_BEATS_BEFORE_STEP_UP && ladderIndex < HEARTBEAT_LADDER_MS.length - 1) {
      ladderIndex += 1
    }
  }

  const resetLadder = () => {
    ladderIndex = 0
    quietStreak = 0
  }

  const handlePowerEvent = (kind: PowerEventKind, _at: Date) => {
    if (kind === 'suspend' || kind === 'lock' || kind === 'idle') {
      tracker.systemEvent(kind, now())
      resetLadder()
    } else {
      resetLadder()
    }
  }

  const beat = async (): Promise<void> => {
    lastBeatAt = now()
    const settings = deps.settings()
    if (!settings.enabled || settings.paused) {
      tracker.paused(now())
      return
    }
    if (deps.permission() !== 'granted') {
      reportError('screen capture permission not granted')
      resetLadder()
      return
    }

    let frontmost: VisionFrontmostInfo
    try {
      frontmost = await deps.ocr.frontmost()
    } catch (error) {
      helperAvailable = false
      reportError(`vision-ocr frontmost failed: ${String(error instanceof Error ? error.message : error)}`)
      resetLadder()
      return
    }
    helperAvailable = true

    if (tracker.currentApp !== null && frontmost.bundleId !== tracker.currentApp) {
      tracker.appSwitched(now())
      resetLadder()
      openSince = null
      keyframeCount = 0
    }
    currentAppName = frontmost.appName
    if (!isAppInScope(settings, frontmost.bundleId)) {
      quietStreak += 1
      stepUpLadder()
      return
    }

    let captured: Awaited<ReturnType<CaptureScreen>>
    try {
      captured = await deps.capture()
    } catch (error) {
      reportError(`screen capture failed: ${String(error instanceof Error ? error.message : error)}`)
      resetLadder()
      return
    }
    if (!captured) {
      reportError('screen capture returned no source')
      resetLadder()
      return
    }

    const capturedAt = now()
    const rawPath = join(inboxDirectory, `beat-${randomUUID()}.jpg`)
    const imageDirectory = imagesDirectoryFor(capturedAt)
    const compressedPath = join(imageDirectory, `SM-${capturedAt.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.jpg`)
    try {
      await ensureDirectories()
      await mkdir(imageDirectory, { recursive: true })
      await writeFile(rawPath, captured.image.toJPEG(RAW_JPEG_QUALITY))
    } catch (error) {
      reportError(`screen-memory raw write failed: ${String(error instanceof Error ? error.message : error)}`)
      await rm(rawPath, { force: true }).catch(() => undefined)
      resetLadder()
      return
    }

    const perceptualHash = calculateDHash(captured.image)
    let result: VisionOcrResult
    try {
      result = await deps.ocr.ocr(rawPath, { compressOut: compressedPath })
    } catch (error) {
      helperAvailable = false
      reportError(`vision-ocr ocr failed: ${String(error instanceof Error ? error.message : error)}`)
      await rm(rawPath, { force: true }).catch(() => undefined)
      await rm(compressedPath, { force: true }).catch(() => undefined)
      resetLadder()
      return
    }
    helperAvailable = true
    lastError = null
    await rm(rawPath, { force: true }).catch(() => undefined)

    const previousStable = tracker.lastStableLines()
    const clustered = clusterOcrLines(result.lines, { width: result.width, height: result.height })
    const decision = diffKeyframeText(previousStable, clustered.orderedLines)
    if (!decision.changed) {
      await rm(compressedPath, { force: true }).catch(() => undefined)
      tracker.heartbeat(capturedAt)
      quietStreak += 1
      stepUpLadder()
      return
    }

    resetLadder()
    tracker.acceptKeyframe({
      now: capturedAt,
      bundleId: frontmost.bundleId ?? 'unknown',
      appName: frontmost.appName ?? frontmost.bundleId ?? 'unknown',
      windowTitle: frontmost.windowTitle,
      keyframe: {
        capturedAt,
        imagePath: compressedPath,
        imageBytes: existsSync(compressedPath) ? result.compressedBytes ?? 0 : 0,
        perceptualHash,
        width: result.width,
        height: result.height,
        lineCount: result.lines.length,
        elapsedMs: result.elapsedMs,
      },
      stableLines: decision.stableLines,
      newLines: decision.newLines,
      newBlocks: blocksWithNewLines(clustered.blocks, decision.newLines),
    })
    if (openSince === null) {
      openSince = capturedAt
      keyframeCount = 0
    }
    keyframeCount += 1
  }

  return {
    start: async () => {
      if (running) return
      running = true
      resetLadder()
      await ensureDirectories()
      powerWatcher = deps.watchPower(handlePowerEvent)
      inFlight = runBeat()
      await inFlight
    },
    stop: async () => {
      running = false
      if (timer) timerApi.clearTimeout(timer)
      timer = null
      if (inFlight) await inFlight.catch(() => undefined)
      inFlight = null
      powerWatcher?.dispose()
      powerWatcher = null
      tracker.stop(now())
      openSince = null
      keyframeCount = 0
    },
    beat: runBeat,
    status: () => ({
      running,
      permission: deps.permission(),
      helperAvailable,
      paused: deps.settings().paused,
      enabled: deps.settings().enabled,
      currentBundleId: tracker.currentApp,
      currentAppName,
      openIntervalSince: openSince?.toISOString() ?? null,
      currentKeyframes: keyframeCount,
      heartbeatMs: currentHeartbeatMs(),
      lastBeatAt: lastBeatAt?.toISOString() ?? null,
      lastError,
    }),
  }
}
