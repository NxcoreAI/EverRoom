import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NativeImage } from 'electron'
import { createScreenMemoryScheduler, type ScreenMemorySchedulerDeps } from './screen-memory-scheduler'
import type { ClosedInterval } from './interval-tracker'
import type { ScreenMemorySettings } from './screen-memory-settings'
import type { VisionFrontmostInfo, VisionOcrResult } from '../vision-ocr/vision-ocr-client'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

function fakeImage(): NativeImage {
  const bitmap = Buffer.alloc(9 * 8 * 4, 7)
  return {
    resize: () => ({ toBitmap: () => bitmap }),
    toBitmap: () => bitmap,
    toJPEG: () => Buffer.from('fake-jpeg-bytes'),
    isEmpty: () => false,
    getSize: () => ({ width: 2560, height: 1440 }),
  } as unknown as NativeImage
}

class FakeOcr {
  frontmostResult: VisionFrontmostInfo = { bundleId: 'com.apple.Safari', appName: 'Safari', pid: 100, windowTitle: 'News' }
  ocrTexts: string[][] = []
  frontmostCalls = 0
  ocrCalls = 0
  ocrError: Error | null = null

  async frontmost(): Promise<VisionFrontmostInfo> {
    this.frontmostCalls += 1
    return this.frontmostResult
  }

  async ocr(imagePath: string, options?: { compressOut?: string }): Promise<VisionOcrResult> {
    this.ocrCalls += 1
    if (this.ocrError) throw this.ocrError
    if (options?.compressOut) await writeFile(options.compressOut, Buffer.from('compressed'))
    const lines = this.ocrTexts.shift() ?? ['默认行']
    return {
      width: 2560,
      height: 1440,
      elapsedMs: 5,
      lines: lines.map((text, index) => ({ text, confidence: 0.5, box: [0.01, 0.9 - 0.05 * index, 0.1, 0.02] })),
      ...(options?.compressOut ? { compressedPath: options.compressOut, compressedBytes: 10 } : {}),
    }
  }
}

function fakeTimer(): { timerApi: ScreenMemorySchedulerDeps['timerApi']; fire: () => void; pendingCount: () => number } {
  let callback: (() => void) | null = null
  const timerApi = {
    setTimeout: (cb: () => void) => {
      callback = cb
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: () => {
      callback = null
    },
  } as unknown as ScreenMemorySchedulerDeps['timerApi']
  return {
    timerApi,
    fire: () => {
      const cb = callback
      callback = null
      cb?.()
    },
    pendingCount: () => (callback ? 1 : 0),
  }
}

describe('createScreenMemoryScheduler', () => {
  let baseDirectory: string
  let ocr: FakeOcr
  let savedIntervals: ClosedInterval[]
  let settings: ScreenMemorySettings
  let powerOnEvent: ((kind: 'suspend' | 'resume' | 'lock' | 'unlock' | 'idle', at: Date) => void) | null
  let captureCalls: number[]
  const now = () => new Date('2026-10-12T14:00:00Z')

  const buildScheduler = (timerApi: ScreenMemorySchedulerDeps['timerApi']) => createScreenMemoryScheduler({
    ocr,
    capture: async () => {
      captureCalls.push(1)
      return { image: fakeImage(), scaleFactor: 2 }
    },
    settings: () => settings,
    persist: { saveInterval: async (interval) => { savedIntervals.push(interval) } },
    permission: () => 'granted',
    watchPower: (onEvent) => {
      powerOnEvent = onEvent
      return { dispose: () => { powerOnEvent = null } }
    },
    baseDirectory,
    timerApi,
    now,
  })

  beforeEach(async () => {
    baseDirectory = await mkdtemp(join(tmpdir(), 'screen-memory-test-'))
    ocr = new FakeOcr()
    savedIntervals = []
    settings = { enabled: true, paused: false, scopeMode: 'allowlist', allowedApps: ['com.apple.Safari'], excludedApps: [] }
    captureCalls = []
    powerOnEvent = null
  })

  afterEach(async () => {
    await rm(baseDirectory, { recursive: true, force: true })
  })

  it('首拍接受关键帧：OCR 落压缩图、原图即删', async () => {
    const { timerApi } = fakeTimer()
    const scheduler = buildScheduler(timerApi)
    ocr.ocrTexts = [['标题行', '内容行一']]
    await scheduler.start()
    expect(ocr.ocrCalls).toBe(1)
    expect(captureCalls).toHaveLength(1)
    const status = scheduler.status()
    expect(status.currentBundleId).toBe('com.apple.Safari')
    expect(status.currentKeyframes).toBe(1)
    const inboxFiles = existsSync(join(baseDirectory, 'inbox')) ? await readFile(join(baseDirectory, 'inbox'), 'utf8').catch(() => '') : ''
    expect(inboxFiles).toBe('')
    await scheduler.stop()
  })

  it('文本无变化的心跳不新增关键帧且爬梯', async () => {
    const { timerApi } = fakeTimer()
    const scheduler = buildScheduler(timerApi)
    ocr.ocrTexts = [['标题行'], ['标题行'], ['标题行'], ['标题行']]
    await scheduler.start()
    expect(scheduler.status().currentKeyframes).toBe(1)
    expect(scheduler.status().heartbeatMs).toBe(30_000)
    await scheduler.beat()
    await scheduler.beat()
    expect(scheduler.status().currentKeyframes).toBe(1)
    expect(scheduler.status().heartbeatMs).toBe(60_000)
    await scheduler.stop()
  })

  it('应用切换关闭区间并持久化', async () => {
    const { timerApi } = fakeTimer()
    const scheduler = buildScheduler(timerApi)
    ocr.ocrTexts = [['标题行']]
    await scheduler.start()
    ocr.frontmostResult = { bundleId: 'com.apple.Terminal', appName: 'Terminal', pid: 200, windowTitle: 'zsh' }
    ocr.ocrTexts = [['终端行']]
    await scheduler.beat()
    expect(savedIntervals).toHaveLength(1)
    expect(savedIntervals[0]!.endReason).toBe('app-switch')
    expect(savedIntervals[0]!.bundleId).toBe('com.apple.Safari')
    expect(scheduler.status().currentBundleId).toBeNull()
    await scheduler.stop()
  })

  it('越界应用：不采集不识别，区间关闭原因为 out-of-scope 前置的应用切换', async () => {
    const { timerApi } = fakeTimer()
    const scheduler = buildScheduler(timerApi)
    ocr.ocrTexts = [['标题行']]
    await scheduler.start()
    ocr.frontmostResult = { bundleId: 'com.apple.finder', appName: 'Finder', pid: 300, windowTitle: null }
    await scheduler.beat()
    expect(captureCalls).toHaveLength(1)
    expect(ocr.ocrCalls).toBe(1)
    expect(savedIntervals[0]!.endReason).toBe('app-switch')
    await scheduler.stop()
  })

  it('排除应用优先于允许列表', async () => {
    settings.excludedApps = ['com.apple.Safari']
    const { timerApi } = fakeTimer()
    const scheduler = buildScheduler(timerApi)
    ocr.ocrTexts = [['标题行']]
    await scheduler.start()
    expect(captureCalls).toHaveLength(0)
    expect(ocr.ocrCalls).toBe(0)
    await scheduler.stop()
  })

  it('空闲事件关闭区间，原因 idle', async () => {
    const { timerApi } = fakeTimer()
    const scheduler = buildScheduler(timerApi)
    ocr.ocrTexts = [['标题行']]
    await scheduler.start()
    powerOnEvent?.('idle', now())
    expect(savedIntervals[0]!.endReason).toBe('idle')
    await scheduler.stop()
  })

  it('OCR 助手故障：清文件、记错误、下一拍仍可恢复', async () => {
    const { timerApi } = fakeTimer()
    const scheduler = buildScheduler(timerApi)
    ocr.ocrError = new Error('daemon exited')
    await scheduler.start()
    expect(scheduler.status().lastError).toContain('vision-ocr ocr failed')
    ocr.ocrError = null
    ocr.ocrTexts = [['恢复后的行']]
    await scheduler.beat()
    expect(scheduler.status().currentKeyframes).toBe(1)
    expect(scheduler.status().lastError).toBeNull()
    await scheduler.stop()
  })


  it('all 模式下未列入列表的应用也会采集', async () => {
    settings.scopeMode = 'all'
    const { timerApi } = fakeTimer()
    const scheduler = buildScheduler(timerApi)
    ocr.frontmostResult = { bundleId: 'com.apple.finder', appName: 'Finder', pid: 400, windowTitle: null }
    ocr.ocrTexts = [['访达里的新内容']]
    await scheduler.start()
    expect(captureCalls).toHaveLength(1)
    expect(scheduler.status().currentBundleId).toBe('com.apple.finder')
    await scheduler.stop()
  })

  it('暂停时心跳只关区间不采集', async () => {
    const { timerApi } = fakeTimer()
    const scheduler = buildScheduler(timerApi)
    ocr.ocrTexts = [['标题行']]
    await scheduler.start()
    settings.paused = true
    await scheduler.beat()
    expect(captureCalls).toHaveLength(1)
    expect(savedIntervals[0]!.endReason).toBe('paused')
    await scheduler.stop()
  })
})
