import type { SubagentInvocation } from '@nxcore/agent-contract'
import { describe, expect, it, vi } from 'vitest'

import type { SubagentOrchestrator } from '../src/modules/subagents/orchestrator.js'
import type { SubagentRegistry } from '../src/modules/subagents/registry.js'
import { createSubagentPiTools } from '../src/modules/subagents/tools.js'

function registryWith(agentIds: string[]): SubagentRegistry {
  return {
    get: (id: string) => (agentIds.includes(id) ? { id } : null),
    listAvailable: () => [],
    listAll: () => [],
  } as unknown as SubagentRegistry
}

function orchestratorReturning(invocation: Partial<SubagentInvocation>): SubagentOrchestrator & {
  dispatch: ReturnType<typeof vi.fn>
} {
  return {
    dispatch: vi.fn(async () => ({
      id: 'invocation-1',
      agentDefinitionId: 'context-room',
      agentRevisionId: 'revision-1',
      source: 'primary_agent',
      parentSessionId: 'session-1',
      parentRunId: 'run-1',
      task: '分析指定 Context Room 的资料并提炼可核验结论',
      input: null,
      status: 'completed',
      result: { text: '' },
      errorCode: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ...invocation,
    })),
  } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
}

const run = { runId: 'run-1', sessionId: 'session-1' }

describe('createSubagentPiTools room_analysis', () => {
  it('registers room_analysis only when the context-room agent exists', () => {
    const withRoom = createSubagentPiTools(
      registryWith(['context-room']),
      orchestratorReturning({}),
    )
    expect(withRoom.map((tool) => tool.name)).toContain('room_analysis')

    const withoutRoom = createSubagentPiTools(registryWith([]), orchestratorReturning({}))
    expect(withoutRoom.map((tool) => tool.name)).not.toContain('room_analysis')
  })

  it('dispatches material-analysis and extracts the structured JSON from the invocation text', async () => {
    const orchestrator = orchestratorReturning({
      result: {
        text: `分析结论：\n\`\`\`json\n${JSON.stringify({
          summary: 'Room 资料围绕校园活动展开',
          facts: [{ content: '社团已登记', source: '活动登记表' }],
          risks: [],
          gaps: ['缺少预算材料'],
          nextSteps: ['补充预算'],
        })}\n\`\`\``,
      },
    })
    const tools = createSubagentPiTools(registryWith(['context-room']), orchestrator)
    const roomAnalysis = tools.find((tool) => tool.name === 'room_analysis')!

    const result = await roomAnalysis.execute(run as never, {
      roomId: 'room-1',
      focus: ' 关注预算 ',
      responseLanguage: ' zh-CN ',
    } as never, undefined)

    expect(orchestrator.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'context-room',
      task: '分析指定 Context Room 的资料并提炼可核验结论',
      input: {
        task: 'material-analysis',
        roomId: 'room-1',
        instruction: '关注预算',
        responseLanguage: 'zh-CN',
      },
      source: 'primary_agent',
      parentSessionId: 'session-1',
      parentRunId: 'run-1',
    }))
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({
      invocationId: 'invocation-1',
      agentId: 'context-room',
      status: 'completed',
      analysis: {
        summary: 'Room 资料围绕校园活动展开',
        facts: [{ content: '社团已登记', source: '活动登记表' }],
        gaps: ['缺少预算材料'],
        nextSteps: ['补充预算'],
      },
    })
  })
})
