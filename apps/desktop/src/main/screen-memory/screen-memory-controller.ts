import { powerMonitor } from 'electron'
import { freemem, totalmem } from 'node:os'

const SUMMARY_IDLE_GATE_SECONDS = 60
const SUMMARY_DISPATCH_POLL_MS = 30_000

import type { VisionOcrClient } from '../vision-ocr/vision-ocr-client'
import { capturePrimaryScreen, getScreenCapturePermission, type CaptureScreen, type ScreenPermissionStatus } from './capture-current-screen'
import { createPowerWatcher, type PowerEventKind, type PowerWatcher } from './power-watcher'
import {
  DEFAULT_SCREEN_MEMORY_SETTINGS,
  getScreenMemoryDirectory,
  ScreenMemorySettingsStore,
  type ScreenMemorySettings,
} from './screen-memory-settings'
import {
  createScreenMemoryScheduler,
  type ScreenMemoryIntervalPersistence,
  type ScreenMemoryScheduler,
  type ScreenMemorySchedulerStatus,
} from './screen-memory-scheduler'

export const SCREEN_MEMORY_CHANNELS = {
  status: 'screen-memory:status',
  settings: 'screen-memory:settings',
  updateSettings: 'screen-memory:update-settings',
  search: 'screen-memory:search',
  intervals: 'screen-memory:intervals',
  interval: 'screen-memory:interval',
  stats: 'screen-memory:stats',
  correct: 'screen-memory:correct',
  storage: 'screen-memory:storage',
  frontmost: 'screen-memory:frontmost',
  openPermissionSettings: 'screen-memory:open-permission-settings',
  registerMaterial: 'screen-memory:register-material',
  backfillEstimate: 'screen-memory:backfill-estimate',
  backfillRun: 'screen-memory:backfill-run',
} as const

export interface ScreenMemoryController {
  getSettings(): ScreenMemorySettings
  updateSettings(patch: Partial<ScreenMemorySettings>): Promise<ScreenMemorySettings>
  getStatus(): ScreenMemorySchedulerStatus & { directory: string; deviceReady: ScreenMemoryDeviceReadiness }
  ensureRunningState(): Promise<void>
  dispose(): Promise<void>
}

export interface ScreenMemoryDeviceReadiness {
  archOk: boolean
  memoryOk: boolean
  diskOk: boolean
}

export function evaluateDeviceReadiness(freeDiskBytes: number): ScreenMemoryDeviceReadiness {
  return {
    archOk: process.arch === 'arm64' || process.arch === 'x64',
    memoryOk: totalmem() >= 8 * 1024 * 1024 * 1024,
    diskOk: freeDiskBytes >= 2 * 1024 * 1024 * 1024,
  }
}

export interface ScreenMemoryControllerDeps {
  ocr: VisionOcrClient
  persist: ScreenMemoryIntervalPersistence
  capture?: CaptureScreen
  permission?: () => ScreenPermissionStatus
  watchPower?: (onEvent: (kind: PowerEventKind, at: Date) => void) => PowerWatcher
  baseDirectory?: string
  now?: () => Date
  timerApi?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>
  onError?: (message: string) => void
  getIdleSeconds?: () => number
  setSummaryDispatch?: (allowed: boolean) => Promise<void>
}

export function createScreenMemoryController(deps: ScreenMemoryControllerDeps): ScreenMemoryController {
  const baseDirectory = deps.baseDirectory ?? getScreenMemoryDirectory()
  const settingsStore = new ScreenMemorySettingsStore()
  let scheduler: ScreenMemoryScheduler | null = null
  let dispatchTimer: ReturnType<typeof setInterval> | null = null
  let lastDispatchAllowed: boolean | null = null

  const syncDispatchState = async (): Promise<void> => {
    if (!deps.setSummaryDispatch) return
    const idleSeconds = (deps.getIdleSeconds ?? (() => powerMonitor.getSystemIdleTime()))()
    const allowed = idleSeconds >= SUMMARY_IDLE_GATE_SECONDS
    if (allowed === lastDispatchAllowed) return
    lastDispatchAllowed = allowed
    await deps.setSummaryDispatch(allowed).catch(() => undefined)
  }

  const startDispatchLoop = () => {
    if (dispatchTimer || !deps.setSummaryDispatch) return
    void syncDispatchState()
    dispatchTimer = setInterval(() => void syncDispatchState(), SUMMARY_DISPATCH_POLL_MS)
    dispatchTimer.unref?.()
  }

  const stopDispatchLoop = () => {
    if (dispatchTimer) clearInterval(dispatchTimer)
    dispatchTimer = null
    lastDispatchAllowed = null
  }

  const ensureScheduler = (): ScreenMemoryScheduler => {
    if (scheduler) return scheduler
    scheduler = createScreenMemoryScheduler({
      ocr: deps.ocr,
      capture: deps.capture ?? capturePrimaryScreen,
      settings: () => settingsStore.read(),
      persist: deps.persist,
      permission: deps.permission ?? getScreenCapturePermission,
      watchPower: deps.watchPower ?? ((onEvent) => createPowerWatcher(powerMonitor, onEvent)),
      baseDirectory,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.timerApi !== undefined ? { timerApi: deps.timerApi } : {}),
      onError: deps.onError,
    })
    return scheduler
  }

  const syncRunningState = async (): Promise<void> => {
    const settings = settingsStore.read()
    const current = ensureScheduler()
    const status = current.status()
    if (settings.enabled && (settings.scopeMode === 'all' || settings.allowedApps.length > 0) && !status.running) {
      await current.start()
      startDispatchLoop()
    } else if ((!settings.enabled || settings.allowedApps.length === 0) && status.running) {
      await current.stop()
      stopDispatchLoop()
    }
  }

  return {
    getSettings: () => settingsStore.read(),
    updateSettings: async (patch) => {
      const previous = settingsStore.read()
      const next = settingsStore.update(patch)
      if (previous.paused && !next.paused) void syncRunningState()
      if (next.enabled && !previous.enabled) await syncRunningState()
      else if (!next.enabled && previous.enabled) await syncRunningState()
      else if (next.paused !== previous.paused) await syncRunningState()
      else void syncRunningState().catch(() => undefined)
      return next
    },
    getStatus: () => {
      const deviceReady = evaluateDeviceReadiness(freemem())
      const base: ScreenMemorySchedulerStatus = scheduler
        ? scheduler.status()
        : {
            running: false,
            permission: (deps.permission ?? getScreenCapturePermission)(),
            helperAvailable: deps.ocr.available,
            paused: settingsStore.read().paused,
            enabled: settingsStore.read().enabled,
            currentBundleId: null,
            currentAppName: null,
            openIntervalSince: null,
            currentKeyframes: 0,
            heartbeatMs: 30_000,
            lastBeatAt: null,
            lastError: null,
          }
      return { ...base, directory: baseDirectory, deviceReady }
    },
    ensureRunningState: syncRunningState,
    dispose: async () => {
      stopDispatchLoop()
      await scheduler?.stop()
      scheduler = null
    },
  }
}

export { DEFAULT_SCREEN_MEMORY_SETTINGS }
export type { ScreenMemorySettings }
export type { ScreenMemoryIntervalPersistence }
