import type { SubagentInvocation } from '@nxcore/agent-contract'
import { describe, expect, it, vi } from 'vitest'

import {
  CONTEXT_ROOM_AGENT_ID,
  ContextRoomAgentDispatcher,
  fallbackContextRoomEnrichment,
  isSelectionRewriteInvocationAuthorized,
  parseBriefRefresh,
  parseContextRoomEnrichment,
  parseMergeNameSuggestions,
  parseRoomOverviewSynthesis,
} from '../src/modules/context-rooms/room-agent.js'

function invocation(overrides: Partial<SubagentInvocation>): SubagentInvocation {
  const now = Date.now()
  return {
    id: 'invocation-1',
    agentDefinitionId: CONTEXT_ROOM_AGENT_ID,
    agentRevisionId: 'revision-1',
    source: 'internal_workflow',
    parentSessionId: null,
    parentRunId: null,
    task: '改写文档选区',
    input: { roomId: 'room-1' },
    status: 'completed',
    result: { text: '改写后的文本' },
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(now - 5_000).toISOString(),
    startedAt: new Date(now - 4_000).toISOString(),
    completedAt: new Date(now - 3_000).toISOString(),
    ...overrides,
  }
}

describe('Context Room Agent enrichment parsing', () => {
  const fallback = fallbackContextRoomEnrichment({
    title: 'Campus Life',
    description: 'Organize campus activities and study notes',
  })

  it('falls back to a pending status derived from the creation input', () => {
    expect(fallback).toMatchObject({
      kind: '主题',
      overview: 'Organize campus activities and study notes',
      status: 'Created; awaiting more material',
      nextSteps: [],
      entities: [],
      facts: [],
    })
    expect(fallbackContextRoomEnrichment({ title: '校园生活', description: '整理资料' }).status)
      .toBe('已创建，等待补充资料')
  })

  it('parses fenced Agent JSON and keeps only supported structured fields', () => {
    expect(parseContextRoomEnrichment(`\`\`\`json
      {
        "kind": "项目",
        "overview": "Campus planning overview",
        "background": "The user is organizing campus life",
        "goal": "Keep activities and study notes together",
        "status": "Relevant memories found",
        "nextSteps": ["Collect the course schedule"],
        "entities": [{"name":"Student Union","kind":"组织","description":"Activity organizer"}],
        "facts": [{"content":"The user follows campus activities","type":"偏好"}]
      }
    \`\`\``, fallback)).toEqual({
      kind: '项目',
      overview: 'Campus planning overview',
      background: 'The user is organizing campus life',
      goal: 'Keep activities and study notes together',
      status: 'Relevant memories found',
      nextSteps: ['Collect the course schedule'],
      entities: [{ name: 'Student Union', kind: '组织', description: 'Activity organizer' }],
      facts: [{ content: 'The user follows campus activities', type: '偏好' }],
    })
  })

  it('falls back to the user description for missing narrative fields', () => {
    expect(parseContextRoomEnrichment('{"kind":"unknown","facts":[]}', fallback)).toMatchObject({
      kind: '主题',
      overview: 'Organize campus activities and study notes',
      background: 'Organize campus activities and study notes',
      goal: 'Organize campus activities and study notes',
      facts: [],
    })
  })

  it('rejects output without a JSON object', () => {
    expect(() => parseContextRoomEnrichment('No structured result', fallback))
      .toThrow('invalid JSON')
  })

  it('parses a brief refresh payload with bounded lists', () => {
    expect(parseBriefRefresh(JSON.stringify({
      background: '新背景',
      goal: '新目标',
      status: '进行中',
      risks: ['风险一', ''],
      decisions: ['决策一'],
    }))).toEqual({
      background: '新背景',
      goal: '新目标',
      status: '进行中',
      risks: ['风险一'],
      decisions: ['决策一'],
    })
  })

  it('parses merge name suggestions with dedupe, trim and caps', () => {
    expect(parseMergeNameSuggestions(JSON.stringify({
      names: ['  校园生活全景  ', '校园生活全景', 'Campus Life Digest', '', '第三', '第四', { not: 'string' }],
    }))).toEqual(['校园生活全景', 'Campus Life Digest', '第三'])
    expect(parseMergeNameSuggestions('{"names": []}')).toEqual([])
    expect(() => parseMergeNameSuggestions('没有结构化结果')).toThrow('invalid JSON')
  })

  it('parses structured overview claims and remains compatible with legacy strings', () => {
    expect(parseRoomOverviewSynthesis(JSON.stringify({
      overview: [{ key: 'delivery-phase', text: '交付进入验证阶段', aspect: 'summary', confidence: 1.2, evidenceRefs: ['fact-1'] }],
      status: [
        { text: '接口已联调', category: 'progress', state: 'active', confidence: 0.9, evidenceRefs: ['doc:1'] },
        { text: '等待法务', category: 'blocker', state: 'active', evidenceRefs: [] },
      ],
      nextSteps: [{ text: '完成验收', owner: '林薇', dueAt: '2026-09-01', priority: 'high', evidenceRefs: ['fact-2'] }],
    }))).toEqual({
      overview: [{ key: 'delivery-phase', text: '交付进入验证阶段', aspect: 'summary', confidence: 1, evidenceRefs: ['fact-1'] }],
      status: [
        { key: null, text: '接口已联调', category: 'progress', state: 'active', confidence: 0.9, evidenceRefs: ['doc:1'] },
        { key: null, text: '等待法务', category: 'blocker', state: 'active', confidence: null, evidenceRefs: [] },
      ],
      nextSteps: [{ key: null, text: '完成验收', owner: '林薇', dueAt: '2026-09-01', priority: 'high', confidence: null, evidenceRefs: ['fact-2'] }],
    })
    expect(parseRoomOverviewSynthesis(JSON.stringify({
      overview: '旧版概览', status: '旧版状态', nextSteps: ['旧版下一步'],
    }))).toMatchObject({
      overview: [{ key: null, text: '旧版概览', aspect: 'summary' }],
      status: [{ key: null, text: '旧版状态', category: 'conclusion', state: 'unknown' }],
      nextSteps: [{ key: null, text: '旧版下一步', owner: null, dueAt: null }],
    })
  })
})

describe('ContextRoomAgentDispatcher', () => {
  it('maps tasks to the context-room subagent with internal_workflow source', async () => {
    const orchestrator = {
      dispatch: vi.fn().mockResolvedValue(invocation({ status: 'running', result: null })),
      startDetached: vi.fn().mockResolvedValue('invocation-detached'),
    }
    const dispatcher = new ContextRoomAgentDispatcher(orchestrator as never)

    await dispatcher.dispatch({
      task: 'room-enrich',
      taskInput: { roomId: 'room-1', title: 'T', description: 'D' },
      idempotencyKey: 'room-enrich:room-1',
    })
    await dispatcher.dispatchDetached({ task: 'selection-rewrite', taskInput: { selectedText: 'x' } })

    expect(orchestrator.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'context-room',
      task: '整理新创建的 Context Room',
      input: { task: 'room-enrich', roomId: 'room-1', title: 'T', description: 'D' },
      idempotencyKey: 'room-enrich:room-1',
      source: 'internal_workflow',
    }))
    expect(orchestrator.startDetached).toHaveBeenCalledWith(expect.objectContaining({
      task: '改写文档选区',
      input: expect.objectContaining({ task: 'selection-rewrite' }),
      idempotencyKey: expect.stringMatching(/^room-agent:/),
    }))
  })
})

describe('isSelectionRewriteInvocationAuthorized', () => {
  const options = { capabilityId: 'document.selection-rewrite', roomId: 'room-1' }

  it('accepts a completed internal context-room invocation for the same room', () => {
    expect(isSelectionRewriteInvocationAuthorized(invocation({}), options)).toBe(true)
  })

  it('rejects other capabilities, agents, sources, and non-terminal runs', () => {
    expect(isSelectionRewriteInvocationAuthorized(invocation({}), {
      capabilityId: 'document.continue',
      roomId: 'room-1',
    })).toBe(false)
    expect(isSelectionRewriteInvocationAuthorized(
      invocation({ agentDefinitionId: 'content-analyst' }),
      options,
    )).toBe(false)
    expect(isSelectionRewriteInvocationAuthorized(invocation({ source: 'primary_agent' }), options)).toBe(false)
    expect(isSelectionRewriteInvocationAuthorized(invocation({ status: 'running', result: null }), options)).toBe(false)
    expect(isSelectionRewriteInvocationAuthorized(null, options)).toBe(false)
  })

  it('rejects invocations outside the operation grace window or bound to another room', () => {
    expect(isSelectionRewriteInvocationAuthorized(invocation({}), {
      ...options,
      now: new Date(Date.now() + 11 * 60 * 1000),
    })).toBe(false)
    expect(isSelectionRewriteInvocationAuthorized(
      invocation({ input: { roomId: 'room-2' } }),
      options,
    )).toBe(false)
  })
})
