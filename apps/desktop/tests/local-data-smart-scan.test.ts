import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectorRegistry } from '../src/main/connectors/connector-registry'
import type { ConnectorSubscription } from '../src/main/connectors/types'
import { LocalDataService } from '../src/main/core/local-data-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('LocalDataService smart scanning', () => {
  it('coalesces changes during a scan into one follow-up and does not poll while idle', async () => {
    vi.useFakeTimers()
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-smart-scan-'))
    temporaryDirectories.push(fixtureRoot)
    const activeScan = deferred()
    let onChange: (() => void) | null = null
    const scan = vi.fn()
      .mockResolvedValueOnce({ items: [], failed: 0 })
      .mockImplementationOnce(async () => {
        await activeScan.promise
        return { items: [], failed: 0 }
      })
      .mockResolvedValue({ items: [], failed: 0 })
    const connector = {
      kind: 'local-folder' as const,
      capabilities: ['pull', 'incremental', 'watch'] as const,
      getConnectionKey: (config: { rootPath: string }) => config.rootPath,
      scan,
      watch: (_connection: unknown, changed: () => void): ConnectorSubscription => {
        onChange = changed
        return { close: vi.fn() }
      },
    }
    const service = new LocalDataService(
      join(fixtureRoot, 'data'),
      new ConnectorRegistry().register(connector),
    )
    await service.initialize()

    try {
      await service.addLocalFolder(fixtureRoot)
      expect(scan).toHaveBeenCalledTimes(1)

      onChange!()
      await vi.advanceTimersByTimeAsync(750)
      expect(scan).toHaveBeenCalledTimes(2)

      onChange!()
      onChange!()
      onChange!()
      activeScan.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(749)
      expect(scan).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(scan).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(scan).toHaveBeenCalledTimes(3)
    } finally {
      await service.shutdown()
    }
  })

  it('reconciles once and rebuilds a failed watcher', async () => {
    vi.useFakeTimers()
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-watcher-retry-'))
    temporaryDirectories.push(fixtureRoot)
    let onError: (() => void) | null = null
    const scan = vi.fn().mockResolvedValue({ items: [], failed: 0 })
    const watch = vi.fn((
      _connection: unknown,
      _changed: () => void,
      failed?: () => void,
    ): ConnectorSubscription => {
      onError = failed ?? null
      return { close: vi.fn() }
    })
    const connector = {
      kind: 'local-folder' as const,
      capabilities: ['pull', 'incremental', 'watch'] as const,
      getConnectionKey: (config: { rootPath: string }) => config.rootPath,
      scan,
      watch,
    }
    const service = new LocalDataService(
      join(fixtureRoot, 'data'),
      new ConnectorRegistry().register(connector),
    )
    await service.initialize()

    try {
      await service.addLocalFolder(fixtureRoot)
      expect(scan).toHaveBeenCalledTimes(1)
      expect(watch).toHaveBeenCalledTimes(1)

      onError!()
      await vi.advanceTimersByTimeAsync(750)
      expect(scan).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(4_250)
      expect(watch).toHaveBeenCalledTimes(2)
    } finally {
      await service.shutdown()
    }
  })
})
