import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HighRiskImportCoordinator } from '../src/main/high-risk-import-coordinator'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

describe('HighRiskImportCoordinator', () => {
  it('persists pending batches and removes them only after a decision succeeds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-risk-reviews-'))
    temporaryDirectories.push(directory)
    const statePath = join(directory, 'reviews.json')
    const first = new HighRiskImportCoordinator(statePath)
    await first.initialize()
    await first.enqueueManual({
      files: [{ filePath: '/tmp/note.md', filename: 'note.md' }],
    }, 'Notes')

    const restored = new HighRiskImportCoordinator(statePath)
    await restored.initialize()
    expect(restored.list()).toMatchObject([{
      origin: 'manual-import', sourceLabel: 'Notes', fileCount: 1,
    }])

    const resolver = vi.fn(async () => ({ accepted: true, imported: 1, failed: 0 }))
    restored.setManualResolver(resolver)
    await expect(restored.resolve(restored.list()[0]!.id, true)).resolves.toEqual({
      accepted: true, imported: 1, failed: 0,
    })
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      files: [{ filePath: '/tmp/note.md', filename: 'note.md' }],
    }), true)
    expect(restored.list()).toEqual([])

    const emptyAfterRestart = new HighRiskImportCoordinator(statePath)
    await emptyAfterRestart.initialize()
    expect(emptyAfterRestart.list()).toEqual([])
  })

  it('keeps a batch pending when its resolver fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-risk-retry-'))
    temporaryDirectories.push(directory)
    const coordinator = new HighRiskImportCoordinator(join(directory, 'reviews.json'))
    await coordinator.initialize()
    const review = await coordinator.enqueueAuto({ sourceId: 'source-1', versionIds: ['version-1'] }, 'Documents')
    coordinator.setAutoResolver(async () => { throw new Error('not ready') })

    await expect(coordinator.resolve(review.id, true)).rejects.toThrow('not ready')
    expect(coordinator.list()).toHaveLength(1)
  })
})
