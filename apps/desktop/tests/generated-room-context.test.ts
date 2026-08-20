import type { KnowledgeRoomContextDto } from '../src/shared/knowledge'
import { describe, expect, it } from 'vitest'

import { applyGeneratedRoomContext } from '../src/renderer/src/components/context-room/ported/generatedRoomContext'
import { createContextRoomFixture } from './context-room-fixture'

function context(actionTitle = '提交修改稿'): KnowledgeRoomContextDto {
  return {
    roomId: 'room-test',
    generatedAt: '2026-08-20T12:00:00.000Z',
    overview: '该 Room 聚焦星港项目的方案评审与交付。',
    sourceDocuments: [{
      documentId: 'doc-1',
      title: '评审纪要',
      version: 1,
      updatedAt: '2026-08-20T11:00:00.000Z',
    }],
    status: '方案正在评审。',
    nextSteps: ['确认评审意见'],
    entities: [{ name: '星港项目', kind: '项目', description: '当前交付项目' }],
    actionItems: [{ title: actionTitle, owner: '林薇', dueDate: '周五', sourceTitle: '评审纪要' }],
    meetings: [{ title: '复盘会', when: '2026-08-21 10:30', participants: ['林薇'], sourceTitle: '评审纪要' }],
  }
}

describe('applyGeneratedRoomContext', () => {
  it('keeps manual details separate and projects document context', () => {
    const room = createContextRoomFixture()
    room.actionItems.push({ id: 'manual', title: '手工任务', status: '进行中', owner: '我', deadline: '明天' })

    const updated = applyGeneratedRoomContext(room, context())

    expect(updated.brief.status).toBe('')
    expect(updated.generatedContext?.status).toBe('方案正在评审。')
    expect(updated.generatedContext?.overview).toBe('该 Room 聚焦星港项目的方案评审与交付。')
    expect(updated.actionItems.map((item) => item.title)).toEqual(['手工任务', '提交修改稿'])
    expect(updated.materials[0]).toMatchObject({ type: '会议', title: '复盘会', generated: true })
    expect(updated.stats).toMatchObject({ docs: 1, meetings: 1, tasks: 2 })
  })

  it('preserves completion state while replacing stale generated details', () => {
    const first = applyGeneratedRoomContext(createContextRoomFixture(), context())
    first.actionItems[0] = { ...first.actionItems[0]!, completed: true, status: '已完成' }

    const refreshed = applyGeneratedRoomContext(first, context())

    expect(refreshed.actionItems[0]).toMatchObject({ completed: true, status: '已完成' })
  })

  it('returns the existing Room when only the generation timestamp changes', () => {
    const room = applyGeneratedRoomContext(createContextRoomFixture(), context())
    const sameContent = {
      ...context(),
      generatedAt: '2026-08-21T12:00:00.000Z',
    }

    expect(applyGeneratedRoomContext(room, sameContent)).toBe(room)
  })
})
