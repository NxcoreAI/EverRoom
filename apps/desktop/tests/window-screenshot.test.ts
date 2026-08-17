import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/workspace/apps/desktop',
    getPath: () => '/workspace/user-data',
  },
  BrowserWindow: { getAllWindows: () => [] },
}))

import {
  SCREENSHOT_DEFAULT_INTERVAL_MS,
  SCREENSHOT_MIN_INTERVAL_MS,
  createWindowScreenshotScheduler,
  type WindowScreenshotCaptureResult,
} from '../src/main/screenshot/window-screenshot-service'

function success(filePath = '/workspace/screenshots/test.jpg'): WindowScreenshotCaptureResult {
  return {
    ok: true,
    filePath,
    fileName: 'test.jpg',
    width: 100,
    height: 100,
    bytes: 10,
    capturedAt: new Date().toISOString(),
  }
}

describe('window screenshot scheduler', () => {
  it('captures immediately and schedules only after the capture completes', async () => {
    const callbacks: Array<() => void> = []
    const capture = vi.fn().mockResolvedValue(success())
    const scheduler = createWindowScreenshotScheduler(capture, {
      setTimeout: (callback) => {
        callbacks.push(callback)
        return callbacks.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: vi.fn(),
    })

    const status = await scheduler.start(120_000)

    expect(capture).toHaveBeenCalledTimes(1)
    expect(status.enabled).toBe(true)
    expect(status.intervalMs).toBe(120_000)
    expect(callbacks).toHaveLength(1)
    expect(status.lastResult?.ok).toBe(true)
  })

  it('normalizes invalid intervals and prevents overlapping captures', async () => {
    let resolveCapture: ((result: WindowScreenshotCaptureResult) => void) | undefined
    const capture = vi.fn(() => new Promise<WindowScreenshotCaptureResult>((resolve) => {
      resolveCapture = resolve
    }))
    const callbacks: Array<() => void> = []
    const scheduler = createWindowScreenshotScheduler(capture, {
      setTimeout: (callback) => {
        callbacks.push(callback)
        return callbacks.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: vi.fn(),
    })

    const startPromise = scheduler.start(1)
    expect(capture).toHaveBeenCalledTimes(1)
    callbacks[0]?.()
    expect(capture).toHaveBeenCalledTimes(1)
    resolveCapture?.(success())
    const status = await startPromise

    expect(status.intervalMs).toBe(SCREENSHOT_MIN_INTERVAL_MS)
    expect(callbacks).toHaveLength(1)
  })

  it('stops future captures while preserving the last result', async () => {
    const callbacks: Array<() => void> = []
    const scheduler = createWindowScreenshotScheduler(
      vi.fn().mockResolvedValue(success()),
      {
        setTimeout: (callback) => {
          callbacks.push(callback)
          return callbacks.length as unknown as ReturnType<typeof setTimeout>
        },
        clearTimeout: vi.fn(),
      },
    )

    await scheduler.start(SCREENSHOT_DEFAULT_INTERVAL_MS)
    const stopped = scheduler.stop()
    callbacks[0]?.()

    expect(stopped.enabled).toBe(false)
    expect(stopped.lastResult?.ok).toBe(true)
  })
})
