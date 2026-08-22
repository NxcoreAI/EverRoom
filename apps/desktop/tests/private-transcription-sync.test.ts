import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { PrivateTranscriptionRecord } from '../src/shared/sources'
import { PrivateTranscriptionSyncService, hasMeaningfulSummary, toImportedRealityEvent } from '../src/main/transcription/private-transcription-sync'

const sourceId = '9f1c963d-2d6e-4ca8-abeb-71cae811a628'
const distinctEventId = 'd5e7ac38-6e75-4a0c-b16f-b4db264b8ef2'

function source(): PrivateTranscriptionRecord {
  return {
    recordId: sourceId,
    revision: 1,
    createdAt: '2026-08-16T16:40:08.068Z',
    updatedAt: '2026-08-16T16:47:44.946Z',
    transcript: '你好，你能听到吗？\n可以听到。',
    segments: [],
    metadata: {
      kind: 'everroom.transcription-source',
      eventId: sourceId,
      startedAt: '2026-08-16T16:47:25Z',
      endedAt: '2026-08-16T16:47:37Z',
      durationMillis: 11_300,
      transcriptLines: [
        { speaker: '发言人 0', startOffsetMillis: 960, text: '你好，你能听到吗？' },
        { speaker: '发言人 1', startOffsetMillis: 9_090, text: '可以听到。' },
      ],
    },
  }
}

function summary(): PrivateTranscriptionRecord {
  return {
    recordId: '12731d88-1100-4dcc-9116-55930c40eae5',
    revision: 2,
    createdAt: '2026-08-16T16:48:03.072Z',
    updatedAt: '2026-08-16T16:48:03.072Z',
    transcript: '确认跨设备同步可用。',
    segments: [],
    metadata: {
      kind: 'everroom.transcription-summary',
      sourceRecordId: sourceId,
      summary: {
        eventType: 'MEETING',
        title: '同步测试',
        overview: '确认跨设备同步可用。',
        keyPoints: ['设备数据已合并'],
        decisions: ['继续验证'],
        actionItems: [{ text: '检查时间线', owner: '小王', dueDate: null }],
        unresolvedQuestions: ['需要继续确认移动端表现'],
        topics: ['跨设备同步'],
      },
    },
  }
}

describe('private transcription reality import', () => {
  it('combines source and summary into the RealityEvent import structure', () => {
    const imported = toImportedRealityEvent(source(), summary())

    expect(imported).toMatchObject({
      id: sourceId,
      title: '同步测试',
      captureDevice: { name: 'iPhone', kind: 'iphone' },
      durationMs: 11_300,
      transcript: '你好，你能听到吗？\n可以听到。',
      insights: {
        source: 'generated',
        eventType: 'MEETING',
        currentTopic: '跨设备同步',
        summary: '确认跨设备同步可用。',
        keyPoints: ['设备数据已合并'],
        decisions: ['继续验证'],
        actionItems: ['检查时间线（负责人：小王）'],
        unresolvedQuestions: ['需要继续确认移动端表现'],
      },
      startedAt: '2026-08-16T16:47:25.000Z',
      endedAt: '2026-08-16T16:47:37.000Z',
    })
    expect(imported?.transcriptSegments).toEqual([
      { text: '你好，你能听到吗？', beginTime: 960, endTime: 9_090, speakerId: 0 },
      { text: '可以听到。', beginTime: 9_090, endTime: 11_300, speakerId: 1 },
    ])
  })

  it('rejects placeholder titles even when the summary has content', () => {
    const empty = summary()
    empty.metadata = {
      ...empty.metadata,
      summary: {
        title: '后台转写总结',
        overview: '这是一段已经生成的概览。',
        keyPoints: ['这是一条已经生成的要点。'],
        decisions: [],
        actionItems: [],
        topics: [],
      },
    }

    expect(hasMeaningfulSummary(empty)).toBe(false)
    expect(hasMeaningfulSummary(summary())).toBe(true)
  })

  it('rejects an under-detailed summary when the source contains substantial content', () => {
    const substantialSource = source()
    substantialSource.transcript = '这段转写包含背景、多个议题、讨论过程、理由、限制条件、结论和后续安排。'.repeat(15)
    const briefSummary = summary()

    expect(hasMeaningfulSummary(briefSummary, substantialSource)).toBe(false)
    expect(hasMeaningfulSummary(briefSummary)).toBe(true)
  })

  it('syncs a transcription whose record and Reality event use different IDs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-private-sync-'))
    const payload = {
      ...source().metadata,
      eventId: distinctEventId,
    }
    const client = {
      status: vi.fn(async () => ({ authenticated: true, user: { id: 'user-1' } })),
      listPrivateRecords: vi.fn(async () => ({
        records: [{
          cursor: 1,
          operation: 'upsert',
          recordId: sourceId,
          recordType: 'transcription_source',
          schemaVersion: 3,
          payload,
          revision: 1,
          createdAt: '2026-08-16T16:40:08.068Z',
          updatedAt: '2026-08-16T16:47:44.946Z',
        }],
        nextCursor: 1,
      })),
      acknowledgeSync: vi.fn(async () => undefined),
    }
    const reality = {
      importEvent: vi.fn(async () => undefined),
      discard: vi.fn(async () => undefined),
    }
    const service = new PrivateTranscriptionSyncService(
      join(directory, 'state.json'),
      client as never,
      {} as never,
      reality as never,
    )

    await expect(service.sync()).resolves.toMatchObject({ cursor: 1, synced: 1 })
    expect(reality.importEvent).toHaveBeenCalledWith(expect.objectContaining({ id: distinctEventId }))
    expect(client.acknowledgeSync).toHaveBeenCalledWith(1)
  })

  it('defers reality materialization behind the materialize gate until it opens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-private-sync-'))
    const client = {
      status: vi.fn(async () => ({ authenticated: true, user: { id: 'user-1' } })),
      listPrivateRecords: vi.fn(async () => ({
        records: [{
          cursor: 1,
          operation: 'upsert',
          recordId: sourceId,
          recordType: 'transcription_source',
          schemaVersion: 3,
          payload: source().metadata,
          revision: 1,
          createdAt: '2026-08-16T16:40:08.068Z',
          updatedAt: '2026-08-16T16:47:44.946Z',
        }],
        nextCursor: 1,
      })),
      acknowledgeSync: vi.fn(async () => undefined),
    }
    const reality = {
      importEvent: vi.fn(async () => undefined),
      discard: vi.fn(async () => undefined),
    }
    const service = new PrivateTranscriptionSyncService(
      join(directory, 'state.json'),
      client as never,
      {} as never,
      reality as never,
    )
    // 闸门闭而未开：sync 拉取照常，但物化（写 Reality/MemoryCore）挂起。
    let release: (() => void) | null = null
    service.setMaterializeGate(() => new Promise<void>((resolve) => { release = resolve }))
    const pending = service.sync()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reality.importEvent).not.toHaveBeenCalled()
    // 开闸（记忆引导结束）：物化继续，事件落库。
    release!()
    await expect(pending).resolves.toMatchObject({ cursor: 1, synced: 1 })
    expect(reality.importEvent).toHaveBeenCalledWith(expect.objectContaining({ id: sourceId }))
  })

  it('uses the record ID when a historical SaaS row has a null event ID', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-private-sync-'))
    const client = {
      status: vi.fn(async () => ({ authenticated: true, user: { id: 'user-1' } })),
      listPrivateRecords: vi.fn(async () => ({
        records: [{
          cursor: 1,
          operation: 'upsert',
          recordId: sourceId,
          recordType: 'transcription_source',
          schemaVersion: 3,
          payload: { ...source().metadata, eventId: null },
          revision: 1,
          createdAt: '2026-08-16T16:40:08.068Z',
          updatedAt: '2026-08-16T16:47:44.946Z',
        }],
        nextCursor: 1,
      })),
      acknowledgeSync: vi.fn(async () => undefined),
    }
    const reality = {
      importEvent: vi.fn(async () => undefined),
      discard: vi.fn(async () => undefined),
    }
    const service = new PrivateTranscriptionSyncService(
      join(directory, 'state.json'),
      client as never,
      {} as never,
      reality as never,
    )

    await expect(service.sync()).resolves.toMatchObject({ cursor: 1, synced: 1 })
    expect(reality.importEvent).toHaveBeenCalledWith(expect.objectContaining({ id: sourceId }))
  })

  it('publishes historical desktop transcriptions but skips synced device events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-private-sync-'))
    const putPrivateRecord = vi.fn(async () => ({}))
    const client = {
      status: vi.fn(async () => ({ authenticated: true, user: { id: 'user-1' } })),
      putPrivateRecord,
    }
    const keyring = {
      status: vi.fn(async () => ({ enabled: true, deviceStatus: 'ready', umkId: 'umk-1', activeVersion: 1 })),
      getUmk: vi.fn(async () => ({ umkId: 'umk-1', version: 1, value: Buffer.alloc(32, 7) })),
    }
    const event = {
      id: 'desktop-event-1',
      captureDevice: { id: 'desktop-local', name: 'This Mac', kind: 'desktop' },
      audioSource: 'microphone',
      durationMs: 1_000,
      transcript: 'A historical desktop transcript.',
      transcriptSegments: [],
      startedAt: '2026-08-17T04:00:00.000Z',
      endedAt: '2026-08-17T04:00:01.000Z',
      asrSource: 'local',
    }
    const reality = {
      listEvents: vi.fn(async () => [
        event,
        { ...event, id: 'iphone-event-1', captureDevice: { id: 'iphone', name: 'iPhone', kind: 'iphone' } },
      ]),
    }
    const service = new PrivateTranscriptionSyncService(
      join(directory, 'state.json'),
      client as never,
      keyring as never,
      reality as never,
    )

    await expect(service.reconcileLocalTranscriptions()).resolves.toBe(1)
    expect(putPrivateRecord).toHaveBeenCalledTimes(1)
    expect(putPrivateRecord).toHaveBeenCalledWith('desktop-event-1', expect.objectContaining({
      recordType: 'transcription_source',
      expectedRevision: 0,
    }))
  })
})
