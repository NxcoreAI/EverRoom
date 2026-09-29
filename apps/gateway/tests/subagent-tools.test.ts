import type { SubagentInvocation } from '@nxcore/agent-contract'
import { describe, expect, it, vi } from 'vitest'

import type { RoomContextDigest } from '../src/modules/context-rooms/room-context-digest.js'
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
      agentDefinitionId: 'content-analyst',
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

/** 与 buildRoomContextDigest 返回结构同构的最小投影夹具。 */
const digestFixture: RoomContextDigest = {
  roomId: 'room-1',
  room: {
    title: '校园活动 Room',
    kind: '项目',
    brief: { background: '筹备社团学期活动' },
    timeline: [],
  },
  facts: [{
    factId: 'fact-1',
    content: '社团已登记',
    type: '属性',
    sourceKind: 'everroom-doc',
    sourceId: 'doc-1',
    sourceTitle: '活动登记表',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }],
  entities: [],
  appliedCorrections: [],
  localActions: [],
  documentCount: 1,
  documents: [{
    documentId: 'doc-1',
    title: '活动登记表',
    version: 1,
    updatedAt: '2026-09-01T00:00:00.000Z',
    markdown: '社团已登记，负责人已确认场地。',
    truncated: false,
  }],
}

describe('createSubagentPiTools room_correction_draft', () => {
  const claimContext = {
    claims: [
      {
        claimId: 'claim-1',
        section: 'overview' as const,
        text: '社团已登记并确认场地。',
        origin: 'fact',
        corrected: false,
        evidence: [{ sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceTitle: '活动登记表' }],
      },
      {
        claimId: 'claim-2',
        section: 'next_steps' as const,
        text: '下一步发布评审通知。',
        origin: 'inference',
        corrected: true,
        evidence: [],
      },
    ],
  }

  it('registers only when room-corrector exists; citation 路径组装 claims 并透传 edits', async () => {
    const withCorrector = createSubagentPiTools(
      registryWith(['room-corrector']),
      orchestratorReturning({}) as never,
      { resolveRoomCorrectionContext: () => claimContext },
    )
    expect(withCorrector.map((tool) => tool.name)).toContain('room_correction_draft')
    expect(createSubagentPiTools(registryWith([]), orchestratorReturning({}))
      .map((tool) => tool.name)).not.toContain('room_correction_draft')

    const orchestrator = orchestratorReturning({
      result: {
        text: '',
        structuredOutput: {
          kind: 'citation-correction',
          edits: [{
            operation: 'content_replace',
            section: 'overview',
            targetClaimId: 'claim-1',
            originalText: '社团已登记并确认场地。',
            replacementText: '社团已完成登记、付款与场地确认。',
            rationale: '按用户评论补充付款状态',
          }],
          summary: '修正了 overview 的一条 claim',
        },
      },
    })
    const tools = createSubagentPiTools(registryWith(['room-corrector']), orchestrator, {
      resolveRoomCorrectionContext: () => claimContext,
    })
    const tool = tools.find((candidate) => candidate.name === 'room_correction_draft')!
    const result = await tool.execute(
      { ...run, roomId: 'room-1', responseLanguage: 'zh-CN' } as never,
      {
        task: 'citation-correction',
        instruction: '场地已经确认了，也付过款了',
        selectedText: '【引用】claim-1 社团已登记并确认场地。【用户评论】补充付款',
      } as never,
      undefined,
    )

    const dispatched = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(dispatched).toMatchObject({ agentId: 'room-corrector', task: '计算总览引用纠正', source: 'primary_agent' })
    const input = dispatched.input as Record<string, unknown>
    expect(input.task).toBe('citation-correction')
    expect(input.selectedText).toContain('社团已登记')
    // 网关组装：claims 快照原样进入（含 nextSteps→next_steps 的 section 映射在 resolver 侧完成）。
    expect(input.claims).toEqual(claimContext.claims)
    expect(input.responseLanguage).toBe('zh-CN')

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({
      status: 'completed',
      kind: 'citation-correction',
      roomId: 'room-1',
      edits: [{ operation: 'content_replace', targetClaimId: 'claim-1' }],
      summary: '修正了 overview 的一条 claim',
    })
  })

  it('general-correction 返回 proposal；citation 缺 selectedText 直接拒绝', async () => {
    const orchestrator = orchestratorReturning({
      result: {
        text: '',
        structuredOutput: {
          kind: 'general-correction',
          proposal: {
            operation: 'content_replace',
            section: 'overview',
            targetClaimId: 'claim-2',
            originalText: '下一步发布评审通知。',
            replacementText: '下一步完成发布评审并归档结论。',
            rationale: '用户要求更新建议',
          },
          summary: '更新了 next_steps 建议',
        },
      },
    })
    const tools = createSubagentPiTools(registryWith(['room-corrector']), orchestrator, {
      resolveRoomCorrectionContext: () => claimContext,
    })
    const tool = tools.find((candidate) => candidate.name === 'room_correction_draft')!
    const result = await tool.execute({ ...run, roomId: 'room-1' } as never, {
      task: 'general-correction',
      instruction: '更新建议下一步',
    } as never, undefined)
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.proposal).toMatchObject({ operation: 'content_replace', section: 'overview' })

    await expect(tool.execute({ ...run, roomId: 'room-1' } as never, {
      task: 'citation-correction',
      instruction: '改一下',
    } as never, undefined)).rejects.toThrow('room_correction_draft_selected_text_required')
  })

  it('room 不存在与并发拒绝的失败语义', async () => {
    const tools = createSubagentPiTools(registryWith(['room-corrector']), orchestratorReturning({}), {
      resolveRoomCorrectionContext: () => null,
    })
    const tool = tools.find((candidate) => candidate.name === 'room_correction_draft')!
    await expect(tool.execute({ ...run, roomId: 'room-1' } as never, {
      task: 'general-correction',
      instruction: 'x',
    } as never, undefined)).rejects.toThrow('context_room_not_found')
  })
})

describe('createSubagentPiTools room_analysis', () => {
  it('registers room_analysis only when the content-analyst agent exists', () => {
    const withAnalyst = createSubagentPiTools(
      registryWith(['content-analyst']),
      orchestratorReturning({}),
    )
    expect(withAnalyst.map((tool) => tool.name)).toContain('room_analysis')

    const withoutAnalyst = createSubagentPiTools(registryWith([]), orchestratorReturning({}))
    expect(withoutAnalyst.map((tool) => tool.name)).not.toContain('room_analysis')

    // 分析任务合并（方案 §4.2）：调度目标已换为 content-analyst，
    // 仅存在 context-room 时不再注册 room_analysis。
    const onlyRoom = createSubagentPiTools(registryWith(['context-room']), orchestratorReturning({}))
    expect(onlyRoom.map((tool) => tool.name)).not.toContain('room_analysis')
  })

  it('assembles the room digest as content and dispatches content-analyst', async () => {
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
    const tools = createSubagentPiTools(registryWith(['content-analyst']), orchestrator, {
      resolveRoomContext: async () => digestFixture,
    })
    const roomAnalysis = tools.find((tool) => tool.name === 'room_analysis')!

    const result = await roomAnalysis.execute(run as never, {
      roomId: 'room-1',
      focus: ' 关注预算 ',
      responseLanguage: ' zh-CN ',
    } as never, undefined)

    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1)
    const dispatchInput = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(dispatchInput).toMatchObject({
      agentId: 'content-analyst',
      task: '分析指定 Context Room 的资料并提炼可核验结论',
      source: 'primary_agent',
      parentSessionId: 'session-1',
      parentRunId: 'run-1',
    })
    const input = dispatchInput.input as Record<string, unknown>
    expect(input.sourceLabel).toBe('校园活动 Room')
    expect(String(input.question)).toContain('关注预算')
    expect(String(input.question)).toContain('zh-CN')
    // content 为网关侧组装的 Room 材料纯文本：房间头 + 文档 markdown + 事实清单。
    expect(String(input.content)).toContain('【Room】校园活动 Room')
    expect(String(input.content)).toContain('### 活动登记表')
    expect(String(input.content)).toContain('社团已登记，负责人已确认场地。')
    expect(String(input.content)).toContain('【结构化事实】')
    expect(String(input.content)).toContain('- 社团已登记（来源：活动登记表）')
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({
      invocationId: 'invocation-1',
      agentId: 'content-analyst',
      status: 'completed',
      analysis: {
        summary: 'Room 资料围绕校园活动展开',
        facts: [{ content: '社团已登记', source: '活动登记表' }],
        gaps: ['缺少预算材料'],
        nextSteps: ['补充预算'],
      },
    })
  })

  it('fails fast when the room digest resolver is missing or finds no room', async () => {
    const withoutResolver = createSubagentPiTools(registryWith(['content-analyst']), orchestratorReturning({}))
    const roomAnalysis = withoutResolver.find((tool) => tool.name === 'room_analysis')!
    await expect(
      roomAnalysis.execute(run as never, { roomId: 'room-1' } as never, undefined),
    ).rejects.toThrow('room_analysis_room_context_unavailable')

    const withNullResolver = createSubagentPiTools(
      registryWith(['content-analyst']),
      orchestratorReturning({}),
      { resolveRoomContext: async () => null },
    )
    const nullRoomAnalysis = withNullResolver.find((tool) => tool.name === 'room_analysis')!
    await expect(
      nullRoomAnalysis.execute(run as never, { roomId: 'missing-room' } as never, undefined),
    ).rejects.toThrow('context_room_not_found')
  })
})

describe('createSubagentPiTools slides_draft', () => {
  /** create 两跳串接：按 agentId 返回各自的 invocation 夹具。 */
  function orchestratorByAgent(handlers: Record<string, Partial<SubagentInvocation>>): SubagentOrchestrator & {
    dispatch: ReturnType<typeof vi.fn>
  } {
    return {
      dispatch: vi.fn(async (input: { agentId: string }) => ({
        id: 'invocation-1',
        agentDefinitionId: input.agentId,
        agentRevisionId: 'revision-1',
        source: 'primary_agent',
        parentSessionId: 'session-1',
        parentRunId: 'run-1',
        task: '演示文稿',
        input: null,
        status: 'completed',
        result: { text: '' },
        errorCode: null,
        errorMessage: null,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        ...handlers[input.agentId],
      })),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
  }

  const planFixture = {
    title: '季度汇报',
    narrative: '业绩回顾到下一步计划',
    pages: [
      { title: '封面', role: 'cover', points: ['季度汇报'] },
      { title: '业绩', role: 'data', points: ['营收增长'], data: 'Q1: 1.2 亿；Q2: 1.5 亿' },
      { title: '计划', role: 'content', points: ['三线扩张'] },
    ],
    warnings: [],
    summary: '3 页方案',
  }

  it('create：先方案后落页两跳——style 不进方案代理、plan 进落页代理，结果归一返回', async () => {
    const orchestrator = orchestratorByAgent({
      'slides-planner': {
        result: {
          text: '',
          structuredOutput: planFixture,
        },
      },
      'slides-builder': {
        result: {
          text: '',
          structuredOutput: {
            status: 'completed',
            fileEntryId: 'file-1',
            fileName: '季度汇报.pptx',
            pages: 3,
            outline: ['封面', '业绩', '计划'],
            warnings: [],
            summary: '已生成 3 页',
          },
        },
      },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator)
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      {
        task: 'create',
        instruction: '做一份 3 页的季度汇报',
        title: '季度汇报',
        style: 'futuristic-tech-editorial',
        outline: ['封面', '业绩', '计划'],
      } as never,
      undefined,
    )

    expect(orchestrator.dispatch).toHaveBeenCalledTimes(2)
    const plannerDispatch = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(plannerDispatch).toMatchObject({ agentId: 'slides-planner', source: 'primary_agent' })
    expect(plannerDispatch.task).toBe('演示文稿内容方案')
    const plannerInput = plannerDispatch.input as Record<string, unknown>
    expect(plannerInput).toMatchObject({
      instruction: '做一份 3 页的季度汇报',
      roomId: 'room-1',
      title: '季度汇报',
    })
    expect(plannerInput.outline).toEqual(['封面', '业绩', '计划'])
    expect(plannerInput.style).toBeUndefined()

    const builderDispatch = orchestrator.dispatch.mock.calls[1]![0] as Record<string, unknown>
    expect(builderDispatch).toMatchObject({ agentId: 'slides-builder', source: 'primary_agent' })
    // 两跳串接成链：落页调用挂靠方案调用之下，时间线据此呈现 "Slides Planner → Slides Builder"
    expect(builderDispatch.parentRunId).toBe('invocation-1')
    const builderInput = builderDispatch.input as Record<string, unknown>
    expect(builderInput).toMatchObject({
      task: 'create',
      instruction: '做一份 3 页的季度汇报',
      roomId: 'room-1',
      title: '季度汇报',
      style: 'futuristic-tech-editorial',
    })
    expect(builderInput.plan).toEqual(planFixture)

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({
      task: 'create',
      status: 'completed',
      fileEntryId: 'file-1',
      fileName: '季度汇报.pptx',
      pages: 3,
      summary: '已生成 3 页',
    })
  })

  it('create：方案阶段失败即返回 failed，不发生落页调度', async () => {
    const orchestrator = orchestratorByAgent({
      'slides-planner': {
        status: 'timed_out',
        errorCode: 'timeout',
      },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator)
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'create', instruction: '做一份季度汇报' } as never,
      undefined,
    )

    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1)
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({ status: 'failed', retryable: true })
    expect(payload.message).toContain('方案阶段未完成')
  })

  it('create：方案代理未注册时返回 failed，不发生调度', async () => {
    const orchestrator = orchestratorReturning({})
    const tools = createSubagentPiTools(registryWith(['slides-builder']), orchestrator)
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'create', instruction: '做一份季度汇报' } as never,
      undefined,
    )

    expect(orchestrator.dispatch).not.toHaveBeenCalled()
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({ status: 'failed', errorCode: 'slides_planner_not_registered' })
  })

  it('edit：不经方案阶段直落 slides-builder；fileId 缺省不进 input；roomId 冲突与缺失直接拒绝', async () => {
    const orchestrator = orchestratorReturning({})
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator)
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    await expect(
      slidesDraft.execute({ ...run, roomId: 'room-1' } as never, { task: 'edit', instruction: '字号调大', roomId: 'room-2' } as never, undefined),
    ).rejects.toThrow('ROOM_SELECTION_MISMATCH')

    await expect(
      slidesDraft.execute(run as never, { task: 'edit', instruction: '字号调大' } as never, undefined),
    ).rejects.toThrow('ROOM_SELECTION_REQUIRED')

    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'edit', instruction: '字号调大', style: 'boardroom' } as never,
      undefined,
    )
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1)
    const dispatched = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(dispatched).toMatchObject({ agentId: 'slides-builder', source: 'primary_agent' })
    const input = dispatched.input as Record<string, unknown>
    expect(input).toMatchObject({ task: 'edit', instruction: '字号调大', roomId: 'room-1' })
    expect(input.fileId).toBeUndefined()
    expect(input.style).toBeUndefined()

    expect(
      createSubagentPiTools(registryWith([]), orchestratorReturning({})).some((tool) => tool.name === 'slides_draft'),
    ).toBe(false)
  })
})
