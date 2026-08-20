import type { AgentRuntime, RuntimeEvent } from '@nxcore/agent-runtime'
import { describe, expect, it, vi } from 'vitest'

import {
  ContextRoomAgentEnricher,
  fallbackContextRoomEnrichment,
  parseContextRoomEnrichment,
} from '../src/modules/context-rooms/agent-enricher.js'

function runtimeWith(events: RuntimeEvent[]): AgentRuntime {
  return {
    id: 'room-test',
    getCapabilities: async () => ({ streaming: true, reasoning: false, tools: true, steering: false, resume: false }),
    start: async () => ({
      runId: 'run-1',
      runtimeSessionRef: '/tmp/room-session.jsonl',
      events: (async function* () { yield* events })(),
    }),
    resume: async () => { throw new Error('not implemented') },
    sendInput: async () => undefined,
    cancel: async () => undefined,
    deleteSession: vi.fn(async () => undefined),
    dispose: async () => undefined,
  }
}

describe('Context Room creation enrichment', () => {
  const fallback = fallbackContextRoomEnrichment({
    title: 'Campus Life',
    description: 'Organize campus activities and study notes',
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

  it('accepts Agent output only after both memory searches and cleans up the session', async () => {
    const runtime = runtimeWith([
      { type: 'tool.started', payload: { name: 'memory_search' } },
      { type: 'tool.started', payload: { name: 'conversation_search' } },
      { type: 'message.completed', payload: { content: JSON.stringify({
        kind: '项目',
        overview: 'Enriched campus context',
        background: 'Campus background',
        goal: 'Campus goal',
        status: 'Ready',
        nextSteps: [],
        entities: [],
        facts: [],
      }) } },
    ])
    const enricher = new ContextRoomAgentEnricher(runtime)

    await expect(enricher.enrich({ title: 'Campus Life', description: 'Campus notes' }))
      .resolves.toMatchObject({ kind: '项目', overview: 'Enriched campus context' })
    expect(runtime.deleteSession).toHaveBeenCalledWith('/tmp/room-session.jsonl')
  })

  it('falls back when the Agent skips a required memory search', async () => {
    const runtime = runtimeWith([
      { type: 'tool.started', payload: { name: 'memory_search' } },
      { type: 'message.completed', payload: { content: '{"kind":"项目","overview":"unsupported"}' } },
    ])
    const enricher = new ContextRoomAgentEnricher(runtime)

    await expect(enricher.enrich({ title: 'Campus Life', description: 'Campus notes' }))
      .resolves.toMatchObject({ kind: '主题', overview: 'Campus notes', facts: [] })
  })
})
