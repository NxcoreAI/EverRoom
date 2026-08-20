import { describe, expect, it } from 'vitest'

import { createRoomUsageGuide } from '../src/renderer/src/components/onboarding/roomUsageGuide'
import { translate } from '../src/renderer/src/i18n/LocaleContext'

function textContent(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const node = value as { text?: unknown; content?: unknown[] }
  return [
    typeof node.text === 'string' ? node.text : '',
    ...(Array.isArray(node.content) ? node.content.map(textContent) : []),
  ].join(' ')
}

describe('Room usage guide', () => {
  it('creates an English guide tailored to the Room kind', () => {
    const guide = createRoomUsageGuide({ id: 'room-123', title: 'Campus Life', kind: '主题' }, (key, values) => translate('en-US', key, values))
    const content = textContent(guide.contentJson)

    expect(guide.documentId).toBe('room-guide-room-123')
    expect(guide.title).toBe('Room User Guide: Campus Life')
    expect(content).toContain('This guide explains how to use the Campus Life Context Room effectively.')
    expect(content).toContain('building a focused knowledge base with references, notes, and open questions')
    expect(content).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('keeps the guide id stable for onboarding retries', () => {
    const room = { id: 'room-123', title: 'Campus Life', kind: '项目' as const }
    const t = (key: string, values?: Record<string, string | number>) => translate('en-US', key, values)
    expect(createRoomUsageGuide(room, t).documentId).toBe(createRoomUsageGuide(room, t).documentId)
  })

  it('uses the selected locale for generated guide copy', () => {
    const room = { id: 'room-123', title: '生活主题', kind: '主题' as const }
    const guide = createRoomUsageGuide(room, (key, values) => translate('zh-CN', key, values))
    const content = textContent(guide.contentJson)

    expect(guide.title).toBe('Room 使用指南：生活主题')
    expect(content).toContain('本指南介绍如何有效使用 生活主题 Context Room。')
    expect(content).toContain('围绕参考资料、笔记和开放问题建立聚焦的知识库')
  })
})
