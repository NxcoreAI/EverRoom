import { describe, expect, it } from 'vitest'

import type { PrivateTranscriptionRecord } from '../src/shared/sources'
import { toImportedRealityEvent } from '../src/main/transcription/private-transcription-sync'

const sourceId = '9f1c963d-2d6e-4ca8-abeb-71cae811a628'

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
        title: '同步测试',
        overview: '确认跨设备同步可用。',
        keyPoints: ['设备数据已合并'],
        decisions: ['继续验证'],
        actionItems: [{ text: '检查时间线', owner: '小王', dueDate: null }],
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
        currentTopic: '跨设备同步',
        summary: '确认跨设备同步可用。',
        keyPoints: ['设备数据已合并'],
        decisions: ['继续验证'],
        actionItems: ['检查时间线（负责人：小王）'],
      },
      startedAt: '2026-08-16T16:47:25.000Z',
      endedAt: '2026-08-16T16:47:37.000Z',
    })
    expect(imported?.transcriptSegments).toEqual([
      { text: '你好，你能听到吗？', beginTime: 960, endTime: 9_090, speakerId: 0 },
      { text: '可以听到。', beginTime: 9_090, endTime: 11_300, speakerId: 1 },
    ])
  })
})
