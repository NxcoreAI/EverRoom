import { describe, expect, it } from 'vitest'

import type { PrivateTranscriptionRecord } from '../../shared/sources'
import { hasMeaningfulSummary } from './private-transcription-sync'
import { buildTranscript, LEGIT_SUMMARY } from './transcription-test-fixtures'

function summaryRecord(overview: string, keyPoints: string[]): PrivateTranscriptionRecord {
  return {
    recordId: 'summary-1',
    revision: 1,
    createdAt: '2026-09-21T10:00:00.000Z',
    updatedAt: '2026-09-21T10:00:00.000Z',
    transcript: '',
    segments: [],
    metadata: {
      kind: 'everroom.transcription-summary',
      summary: { eventType: 'MEETING', title: '项目周会', overview, keyPoints },
    },
  }
}

function sourceRecord(transcript: string): PrivateTranscriptionRecord {
  return {
    recordId: 'source-1',
    revision: 1,
    createdAt: '2026-09-21T09:00:00.000Z',
    updatedAt: '2026-09-21T09:00:00.000Z',
    transcript,
    segments: [],
    metadata: { kind: 'everroom.transcription-source' },
  }
}

const keyPoints = ['评审意见下周三前交付', '数据源延迟是主要风险', '数据侧先给缓冲方案', '各负责人会后确认时间点']

describe('hasMeaningfulSummary', () => {
  it('接受结构完整、重新组织的总结', () => {
    expect(hasMeaningfulSummary(summaryRecord(LEGIT_SUMMARY, keyPoints), sourceRecord(buildTranscript()))).toBe(true)
  })

  it('拒绝 overview 整段照抄逐字稿的总结，触发重处理通道（#260）', () => {
    const transcript = buildTranscript()
    expect(hasMeaningfulSummary(summaryRecord(transcript, keyPoints), sourceRecord(transcript))).toBe(false)
  })

  it('无结构化内容或占位标题直接判无效', () => {
    expect(hasMeaningfulSummary(undefined, sourceRecord(buildTranscript()))).toBe(false)
    expect(hasMeaningfulSummary(summaryRecord('', []), sourceRecord(buildTranscript()))).toBe(false)
  })
})

describe('PrivateTranscriptionSyncService 跨账号记录 id 冲突', () => {
  it('409 owned-by-another-account 时丢弃待传记录且不再重排队', async () => {
    const { PrivateTranscriptionSyncService } = await import('./private-transcription-sync')
    const { SaasRequestError } = await import('../cloud/saas-client')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = await mkdtemp(join(tmpdir(), 'pts-409-'))
    const eventId = '10000000-0000-4000-8000-000000000003'
    const event = {
      id: eventId,
      startedAt: '2026-09-24T10:00:00.000Z',
      endedAt: '2026-09-24T10:01:00.000Z',
      durationMs: 60_000,
      captureDevice: { kind: 'desktop' },
      audioSource: 'mic',
      asrSource: 'local',
      transcript: '冲突记录',
      transcriptSegments: [],
    } as never
    const putCalls: string[] = []
    const client = {
      status: async () => ({ authenticated: true, user: { id: 'user-1' } }),
      putPrivateRecord: async (recordId: string) => {
        putCalls.push(recordId)
        throw new SaasRequestError('Record id is owned by another account', 409)
      },
    } as never
    const reality = { listEvents: async () => [event] } as never
    const service = new PrivateTranscriptionSyncService(join(dir, 'sync-state.json'), client, {} as never, reality)

    try {
      await expect(
        service.publishLocalTranscription(event, { transcript: '冲突记录', segments: [] }, 'local'),
      ).resolves.toBeUndefined()

      const queued = await service.reconcileLocalTranscriptions()
      expect(queued).toBe(0)
      expect(putCalls).toEqual([eventId])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
