import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RoomOverviewScheduler } from '../src/modules/context-rooms/overview-scheduler.js'

function noopLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
  }
}

describe('RoomOverviewScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces repeated notifies into one regeneration', async () => {
    const regenerate = vi.fn(async () => undefined)
    const scheduler = new RoomOverviewScheduler(noopLogger(), { debounceMs: 1000, cooldownMs: 60_000 })
    scheduler.setRegenerate(regenerate)

    scheduler.notifySourcesChanged(['room-1'], 'ingest')
    vi.advanceTimersByTime(500)
    scheduler.notifySourcesChanged(['room-1'], 'relation-index')
    vi.advanceTimersByTime(500)
    expect(regenerate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(600)
    expect(regenerate).toHaveBeenCalledTimes(1)
    expect(regenerate).toHaveBeenCalledWith('room-1')
  })

  it('applies the cooldown window after a success', async () => {
    const regenerate = vi.fn(async () => undefined)
    const scheduler = new RoomOverviewScheduler(noopLogger(), { debounceMs: 100, cooldownMs: 60_000 })
    scheduler.setRegenerate(regenerate)

    scheduler.notifySourcesChanged(['room-1'], 'ingest')
    await vi.advanceTimersByTimeAsync(150)
    expect(regenerate).toHaveBeenCalledTimes(1)

    scheduler.notifySourcesChanged(['room-1'], 'ingest')
    await vi.advanceTimersByTimeAsync(500)
    expect(regenerate).toHaveBeenCalledTimes(1)

    scheduler.notifySourcesChanged(['room-2'], 'ingest')
    await vi.advanceTimersByTimeAsync(500)
    expect(regenerate).toHaveBeenCalledTimes(2)
    expect(regenerate).toHaveBeenLastCalledWith('room-2')
  })

  it('backs off after a failure and retries later', async () => {
    const regenerate = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined)
    const scheduler = new RoomOverviewScheduler(noopLogger(), {
      debounceMs: 100,
      cooldownMs: 60_000,
      failureCooldownMs: 5_000,
    })
    scheduler.setRegenerate(regenerate)

    scheduler.notifySourcesChanged(['room-1'], 'ingest')
    await vi.advanceTimersByTimeAsync(150)
    expect(regenerate).toHaveBeenCalledTimes(1)

    // 失败退避期内：去抖窗口走完也不再尝试。
    scheduler.notifySourcesChanged(['room-1'], 'ingest')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(regenerate).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000)
    scheduler.notifySourcesChanged(['room-1'], 'ingest')
    await vi.advanceTimersByTimeAsync(150)
    expect(regenerate).toHaveBeenCalledTimes(2)
  })

  it('re-arms when a regeneration is already in flight', async () => {
    let release: (() => void) | null = null
    const regenerate = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const scheduler = new RoomOverviewScheduler(noopLogger(), { debounceMs: 100, cooldownMs: 60_000 })
    scheduler.setRegenerate(regenerate)

    scheduler.notifySourcesChanged(['room-1'], 'ingest')
    await vi.advanceTimersByTimeAsync(150)
    expect(regenerate).toHaveBeenCalledTimes(1)

    // 第一次仍在飞行中：补一次去抖窗，释放后应再生成。
    scheduler.notifySourcesChanged(['room-1'], 'relation-index')
    await vi.advanceTimersByTimeAsync(50)
    release!()
    await vi.advanceTimersByTimeAsync(200)
    expect(regenerate).toHaveBeenCalledTimes(2)
  })

  it('schedules an initial regeneration for a newly created room', async () => {
    const regenerate = vi.fn(async () => undefined)
    const scheduler = new RoomOverviewScheduler(noopLogger(), { debounceMs: 100, cooldownMs: 60_000 })
    scheduler.setRegenerate(regenerate)

    scheduler.notifyRoomCreated('room-new')
    await vi.advanceTimersByTimeAsync(150)
    expect(regenerate).toHaveBeenCalledTimes(1)
    expect(regenerate).toHaveBeenCalledWith('room-new')
  })

  it('drops notifications for deleted rooms without recording a failure', async () => {
    const regenerate = vi.fn().mockRejectedValue(new Error('context_room_not_found'))
    const logger = { info: vi.fn(), warn: vi.fn() }
    const scheduler = new RoomOverviewScheduler(logger, { debounceMs: 100, cooldownMs: 60_000 })
    scheduler.setRegenerate(regenerate)

    scheduler.notifySourcesChanged(['room-gone'], 'ingest')
    await vi.advanceTimersByTimeAsync(150)
    expect(logger.warn).not.toHaveBeenCalled()

    // 未记失败：下一次通知应立即再排程（而非进入退避）。
    regenerate.mockResolvedValue(undefined)
    scheduler.notifySourcesChanged(['room-gone'], 'ingest')
    await vi.advanceTimersByTimeAsync(150)
    expect(regenerate).toHaveBeenCalledTimes(2)
  })

  it('dispose cancels pending timers', async () => {
    const regenerate = vi.fn(async () => undefined)
    const scheduler = new RoomOverviewScheduler(noopLogger(), { debounceMs: 1000 })
    scheduler.setRegenerate(regenerate)

    scheduler.notifySourcesChanged(['room-1'], 'ingest')
    scheduler.dispose()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(regenerate).not.toHaveBeenCalled()
  })

  it('honors a custom delay for initial sweeps', async () => {
    const regenerate = vi.fn(async () => undefined)
    const scheduler = new RoomOverviewScheduler(noopLogger(), { debounceMs: 3_600_000 })
    scheduler.setRegenerate(regenerate)

    scheduler.notifySourcesChanged(['room-1'], 'initial-sweep', { delayMs: 500 })
    await vi.advanceTimersByTimeAsync(600)
    expect(regenerate).toHaveBeenCalledTimes(1)
  })

  it('ignores failure cooldown when asked to', async () => {
    const regenerate = vi.fn()
      .mockRejectedValueOnce(new Error('agent_runtime_unavailable'))
      .mockResolvedValue(undefined)
    const scheduler = new RoomOverviewScheduler(noopLogger(), {
      debounceMs: 100,
      cooldownMs: 60_000,
      failureCooldownMs: 3_600_000,
    })
    scheduler.setRegenerate(regenerate)

    scheduler.notifySourcesChanged(['room-1'], 'initial-sweep')
    await vi.advanceTimersByTimeAsync(150)
    expect(regenerate).toHaveBeenCalledTimes(1)

    // 失败退避期内：普通通知被拦，ignoreFailureCooldown 放行（runtime config 就绪后重试）。
    scheduler.notifySourcesChanged(['room-1'], 'ingest')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(regenerate).toHaveBeenCalledTimes(1)

    scheduler.notifySourcesChanged(['room-1'], 'initial-sweep', { delayMs: 100, ignoreFailureCooldown: true })
    await vi.advanceTimersByTimeAsync(150)
    expect(regenerate).toHaveBeenCalledTimes(2)
  })

  it('retries briefly on concurrency rejection without recording a failure', async () => {
    const regenerate = vi.fn()
      .mockRejectedValueOnce(new Error('subagent_concurrency_limit'))
      .mockResolvedValue(undefined)
    const scheduler = new RoomOverviewScheduler(noopLogger(), { debounceMs: 100, failureCooldownMs: 3_600_000 })
    scheduler.setRegenerate(regenerate)

    scheduler.notifySourcesChanged(['room-1'], 'initial-sweep')
    await vi.advanceTimersByTimeAsync(150)
    expect(regenerate).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(regenerate).toHaveBeenCalledTimes(2)
  })

  it('stops accepting notifications after dispose', async () => {
    const regenerate = vi.fn(async () => undefined)
    const scheduler = new RoomOverviewScheduler(noopLogger(), { debounceMs: 100 })
    scheduler.setRegenerate(regenerate)
    scheduler.dispose()

    scheduler.notifySourcesChanged(['room-1'], 'ingest')
    await vi.advanceTimersByTimeAsync(500)
    expect(regenerate).not.toHaveBeenCalled()
  })
})
