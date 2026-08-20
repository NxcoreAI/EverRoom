import { describe, expect, it } from 'vitest'

import { buildAgentRunContext } from './agentRunContext'

describe('buildAgentRunContext', () => {
  it('includes the latest user-authored Room information', () => {
    expect(buildAgentRunContext([{
      id: 'room-1',
      title: '发布计划',
      kind: '项目',
      background: '  聚合发布资料  ',
      goal: '完成 V1',
      status: '等待评审',
      contextSummary: {
        overview: '该 Room 聚焦发布计划与评审。',
        nextSteps: ['确认评审意见'],
        entities: [],
        actionItems: [],
        meetings: [],
        sourceDocuments: [],
      },
    }], undefined, 'room-1')).toMatchObject({
      selectedRoomId: 'room-1',
      rooms: [{
        id: 'room-1',
        title: '发布计划',
        kind: '项目',
        background: '聚合发布资料',
        goal: '完成 V1',
        status: '等待评审',
        contextSummary: expect.objectContaining({ nextSteps: ['确认评审意见'] }),
      }],
    })
  })
})
