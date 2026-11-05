import { describe, expect, it } from 'vitest'

import { buildAgentRunContext } from './agentRunContext'

describe('buildAgentRunContext', () => {
  it('Phase 2i 去 Room：run context 不再携带 rooms/selectedRoomId', () => {
    const context = buildAgentRunContext('选中文本', undefined, '首页')
    expect(context).toMatchObject({ pageLabel: '首页', selectedText: '选中文本' })
    expect(context).not.toHaveProperty('rooms')
    expect(context).not.toHaveProperty('selectedRoomId')
  })

  it('passes a previous Agent chat as a one-turn reference', () => {
    expect(buildAgentRunContext(undefined, undefined, undefined, undefined, 'thread-1'))
      .toMatchObject({ referencedConversationId: 'thread-1' })
  })

  it('passes mounted directories into the run context', () => {
    expect(buildAgentRunContext(undefined, undefined, undefined, [
      { path: '/Users/me/docs/', name: 'docs' },
    ])).toMatchObject({
      mountedDirectories: [{ path: '/Users/me/docs/', name: 'docs' }],
    })
    // 只提交目录名/路径两个字段，其余运行上下文键保持缺席。
    expect(buildAgentRunContext(undefined, undefined, undefined, []))
      .not.toHaveProperty('mountedDirectories')
  })

  it('passes @ mentioned local Agent ids as dispatch references', () => {
    expect(buildAgentRunContext(undefined, undefined, undefined, undefined, undefined, ['codex:/usr/local/bin/codex', 'claude:/usr/local/bin/claude']))
      .toMatchObject({ referencedLocalAgentIds: ['codex:/usr/local/bin/codex', 'claude:/usr/local/bin/claude'] })
    expect(buildAgentRunContext(undefined, undefined, undefined, undefined, undefined, undefined))
      .not.toHaveProperty('referencedLocalAgentIds')
  })
})
