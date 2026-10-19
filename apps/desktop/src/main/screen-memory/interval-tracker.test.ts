import { describe, expect, it } from 'vitest'

import { IntervalTracker, type ClosedInterval, type KeyframeRecord } from './interval-tracker'

function keyframe(capturedAt: Date, imagePath = '/tmp/sm-1.jpg'): KeyframeRecord {
  return {
    capturedAt,
    imagePath,
    imageBytes: 54_976,
    perceptualHash: '00ff00ff00ff00ff',
    width: 2560,
    height: 1440,
    lineCount: 5,
    elapsedMs: 700,
  }
}

function keyframeInput(overrides: Partial<Parameters<IntervalTracker['acceptKeyframe']>[0]> = {}) {
  const now = new Date('2026-10-12T14:00:00Z')
  return {
    now,
    bundleId: 'com.apple.Safari',
    appName: 'Safari',
    windowTitle: 'PRD 评审 - Safari',
    keyframe: keyframe(now),
    stableLines: ['标题行', '内容行一'],
    newLines: ['标题行', '内容行一'],
    newBlocks: ['标题行\n内容行一'],
    ...overrides,
  }
}

describe('IntervalTracker', () => {
  it('首帧开区间，文本并集去重', () => {
    const closed: ClosedInterval[] = []
    const tracker = new IntervalTracker({ onIntervalClosed: (interval) => closed.push(interval) })
    const t1 = new Date('2026-10-12T14:00:00Z')
    const t2 = new Date('2026-10-12T14:02:00Z')

    tracker.acceptKeyframe(keyframeInput({ now: t1, newLines: ['标题行', '内容行一', '标题行 '] }))
    tracker.acceptKeyframe(keyframeInput({
      now: t2,
      keyframe: keyframe(t2, '/tmp/sm-2.jpg'),
      stableLines: ['标题行', '内容行一', '内容行二'],
      newLines: ['内容行二'],
      newBlocks: ['标题行\n内容行一', '内容行二'],
    }))
    expect(tracker.openInterval).toBe(true)
    expect(tracker.lastStableLines()).toEqual(['标题行', '内容行一', '内容行二'])
    expect(closed).toEqual([])
  })

  it('文本块并集去重，随区间关闭带出', () => {
    const closed: ClosedInterval[] = []
    const tracker = new IntervalTracker({ onIntervalClosed: (interval) => closed.push(interval) })
    tracker.acceptKeyframe(keyframeInput({ newBlocks: ['块一\n块一行二', '块二'] }))
    tracker.acceptKeyframe(keyframeInput({
      keyframe: keyframe(new Date('2026-10-12T14:03:00Z'), '/tmp/sm-2.jpg'),
      newLines: ['新行'],
      newBlocks: ['块二', '块三'],
    }))
    tracker.stop(new Date('2026-10-12T14:04:00Z'))
    expect(closed[0]?.textBlocks).toEqual(['块一\n块一行二', '块二', '块三'])
  })

  it('应用切换关区间，原因与起止时间正确', () => {
    const closed: ClosedInterval[] = []
    const tracker = new IntervalTracker({ onIntervalClosed: (interval) => closed.push(interval) })
    const start = new Date('2026-10-12T14:00:00Z')
    const switchAt = new Date('2026-10-12T14:12:00Z')
    tracker.acceptKeyframe(keyframeInput({ now: start }))
    tracker.heartbeat(new Date('2026-10-12T14:05:00Z'))
    const interval = tracker.appSwitched(switchAt)
    expect(interval?.endReason).toBe('app-switch')
    expect(interval?.startedAt).toEqual(start)
    expect(interval?.endedAt).toEqual(new Date('2026-10-12T14:05:00Z'))
    expect(closed).toHaveLength(1)
    expect(tracker.openInterval).toBe(false)
  })

  it('锁屏以事件时刻作为结束时间', () => {
    const closed: ClosedInterval[] = []
    const tracker = new IntervalTracker({ onIntervalClosed: (interval) => closed.push(interval) })
    tracker.acceptKeyframe(keyframeInput({ now: new Date('2026-10-12T14:00:00Z') }))
    const lockAt = new Date('2026-10-12T14:30:00Z')
    tracker.systemEvent('lock', lockAt)
    expect(closed[0]?.endReason).toBe('lock')
    expect(closed[0]?.endedAt).toEqual(lockAt)
  })

  it('标题取窗口标题，缺省时退回首行文本', () => {
    const closed: ClosedInterval[] = []
    const tracker = new IntervalTracker({ onIntervalClosed: (interval) => closed.push(interval) })
    tracker.acceptKeyframe(keyframeInput({ windowTitle: null, newLines: ['首行内容'] }))
    tracker.stop(new Date())
    expect(closed[0]?.title).toBe('首行内容')
  })

  it('越界应用帧在切换后由调度器关闭，tracker 内不接受异应用帧', () => {
    const tracker = new IntervalTracker({ onIntervalClosed: () => undefined })
    tracker.acceptKeyframe(keyframeInput())
    tracker.acceptKeyframe(keyframeInput({ bundleId: 'com.apple.Terminal', appName: 'Terminal' }))
    expect(tracker.currentApp).toBe('com.apple.Terminal')
  })
})
