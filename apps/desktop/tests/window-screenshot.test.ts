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
  calculateDHash,
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
  it('computes a stable 64-bit perceptual hash from a 9 by 8 sample', () => {
    const pixels = Buffer.alloc(9 * 8 * 4)
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 9; x += 1) {
        const index = (y * 9 + x) * 4
        pixels[index] = x
        pixels[index + 1] = x
        pixels[index + 2] = x
        pixels[index + 3] = 255
      }
    }
    const image = { resize: () => ({ toBitmap: () => pixels }) }
    expect(calculateDHash(image as never)).toBe('0000000000000000')
  })

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

  it('remembers an interval configured while capture is disabled', async () => {
    const scheduler = createWindowScreenshotScheduler(vi.fn().mockResolvedValue(success()))

    const updated = scheduler.updateInterval(3_600_000)

    expect(updated.enabled).toBe(false)
    expect(updated.intervalMs).toBe(3_600_000)
    expect(scheduler.getStatus().intervalMs).toBe(3_600_000)
  })
})
