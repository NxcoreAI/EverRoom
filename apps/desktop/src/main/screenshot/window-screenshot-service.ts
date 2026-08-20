import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { app, BrowserWindow, type NativeImage } from 'electron'

export const SCREENSHOT_DEFAULT_INTERVAL_MS = 300_000
export const SCREENSHOT_MIN_INTERVAL_MS = 30_000
export const SCREENSHOT_MAX_INTERVAL_MS = 3_600_000

export interface WindowScreenshotResult {
  ok: true
  filePath: string
  fileName: string
  width: number
  height: number
  bytes: number
  capturedAt: string
  perceptualHash?: string
}

export interface WindowScreenshotFailure {
  ok: false
  code: 'window-unavailable' | 'capture-failed' | 'save-failed'
  message: string
}

export type WindowScreenshotCaptureResult = WindowScreenshotResult | WindowScreenshotFailure

export interface WindowScreenshotStatus {
  enabled: boolean
  intervalMs: number
  lastResult: WindowScreenshotCaptureResult | null
}

export interface WindowScreenshotScheduler {
  start(intervalMs: number): Promise<WindowScreenshotStatus>
  updateInterval(intervalMs: number): WindowScreenshotStatus
  stop(): WindowScreenshotStatus
  getStatus(): WindowScreenshotStatus
}

function normalizeIntervalMs(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : SCREENSHOT_DEFAULT_INTERVAL_MS
  return Math.min(SCREENSHOT_MAX_INTERVAL_MS, Math.max(SCREENSHOT_MIN_INTERVAL_MS, numeric))
}

export function getScreenshotDirectory(): string {
  const configured = process.env.NXCORE_SCREENSHOT_DIR?.trim()
  if (configured) return configured
  if (!app.isPackaged) return join(app.getAppPath(), '..', '..', 'screenshots')
  return join(app.getPath('userData'), 'screenshots')
}

function sanitizeFileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

export function calculateDHash(image: NativeImage): string {
  const sample = image.resize({ width: 9, height: 8, quality: 'best' })
  const pixels = sample.toBitmap()
  let hash = 0n
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = (y * 9 + x) * 4
      const right = left + 4
      const leftBrightness = pixels[left]! + pixels[left + 1]! + pixels[left + 2]!
      const rightBrightness = pixels[right]! + pixels[right + 1]! + pixels[right + 2]!
      hash = (hash << 1n) | (leftBrightness > rightBrightness ? 1n : 0n)
    }
  }
  return hash.toString(16).padStart(16, '0')
}

export async function captureCurrentWindow(
  window: BrowserWindow | null = BrowserWindow.getAllWindows()[0] ?? null,
): Promise<WindowScreenshotCaptureResult> {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return { ok: false, code: 'window-unavailable', message: '当前应用窗口不可用。' }
  }

  let image
  try {
    image = await window.webContents.capturePage()
  } catch {
    return { ok: false, code: 'capture-failed', message: '应用窗口截图失败，请稍后重试。' }
  }

  if (image.isEmpty()) {
    return { ok: false, code: 'capture-failed', message: '应用窗口截图为空，请稍后重试。' }
  }

  const size = image.getSize()
  const perceptualHash = calculateDHash(image)
  let jpeg: Buffer
  try {
    jpeg = image.toJPEG(82)
  } catch {
    return { ok: false, code: 'capture-failed', message: '应用窗口截图编码失败，请稍后重试。' }
  }
  if (!jpeg.byteLength) {
    return { ok: false, code: 'capture-failed', message: '应用窗口截图为空，请稍后重试。' }
  }

  const capturedAt = new Date()
  const fileName = `EverRoom-window-${sanitizeFileTimestamp(capturedAt)}-${randomUUID()}.jpg`
  const directory = getScreenshotDirectory()
  const filePath = join(directory, fileName)
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`

  try {
    await mkdir(directory, { recursive: true })
    await writeFile(temporaryPath, jpeg, { flag: 'wx' })
    await rename(temporaryPath, filePath)
  } catch {
    await unlink(temporaryPath).catch(() => undefined)
    return { ok: false, code: 'save-failed', message: '截图无法保存，请检查目录权限和磁盘空间。' }
  }

  return {
    ok: true,
    filePath,
    fileName,
    width: size.width,
    height: size.height,
    bytes: jpeg.byteLength,
    capturedAt: capturedAt.toISOString(),
    perceptualHash,
  }
}

export function createWindowScreenshotScheduler(
  capture: () => Promise<WindowScreenshotCaptureResult> = () => captureCurrentWindow(),
  timerApi: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis,
  onCaptured?: (result: WindowScreenshotResult) => Promise<void> | void,
): WindowScreenshotScheduler {
  let enabled = false
  let intervalMs = SCREENSHOT_DEFAULT_INTERVAL_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let lastResult: WindowScreenshotCaptureResult | null = null

  const clearScheduledTimer = () => {
    if (timer) timerApi.clearTimeout(timer)
    timer = null
  }

  const getStatus = (): WindowScreenshotStatus => ({ enabled, intervalMs, lastResult })

  const scheduleNext = () => {
    if (!enabled || timer || inFlight) return
    timer = timerApi.setTimeout(() => {
      timer = null
      void runCapture()
    }, intervalMs)
  }

  const runCapture = async () => {
    if (!enabled || inFlight) return
    const current = capture().then(async (result) => {
      lastResult = result
      if (result.ok) await Promise.resolve(onCaptured?.(result)).catch(() => undefined)
    }).catch(() => {
      lastResult = { ok: false, code: 'capture-failed', message: '应用窗口截图失败，请稍后重试。' }
    })
    inFlight = current
    try {
      await current
    } finally {
      inFlight = null
      scheduleNext()
    }
  }

  return {
    start: async (nextIntervalMs) => {
      if (inFlight) await inFlight
      clearScheduledTimer()
      enabled = true
      intervalMs = normalizeIntervalMs(nextIntervalMs)
      await runCapture()
      return getStatus()
    },
    updateInterval: (nextIntervalMs) => {
      intervalMs = normalizeIntervalMs(nextIntervalMs)
      clearScheduledTimer()
      scheduleNext()
      return getStatus()
    },
    stop: () => {
      clearScheduledTimer()
      enabled = false
      return getStatus()
    },
    getStatus,
  }
}
