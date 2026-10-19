import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import type { SubagentInvocation } from '@nxcore/agent-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RoomContextDigest } from '../src/modules/context-rooms/room-context-digest.js'
import type { SubagentOrchestrator } from '../src/modules/subagents/orchestrator.js'
import type { SubagentRegistry } from '../src/modules/subagents/registry.js'
import { createSubagentPiTools } from '../src/modules/subagents/tools.js'
import type { SlidesStyleStageDeps } from '../src/modules/subagents/slides-style-stage.js'
import type { SlidesStyleImageGenerator } from '../src/modules/slides-style/image-gen.js'
import { SlidesStyleSessionStore } from '../src/modules/slides-style/style-session.js'
import { SlidesPageImageSessionStore } from '../src/modules/subagents/slides-page-images-store.js'
import { SlidesPageImageRunner } from '../src/modules/subagents/slides-page-images-runner.js'
import type { DatabaseClient } from '../src/infrastructure/database/client.js'
import { createDatabase } from '../src/infrastructure/database/client.js'

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

/** 布局树链路测试夹具：每页一棵结构互异的有效树（避免相似度重排干扰断言）。 */
function layouterTreeFor(pageIndex: number): Record<string, unknown> {
  const directions = ['column', 'row'] as const
  return {
    role: 'content',
    title: `第 ${pageIndex + 1} 页`,
    direction: directions[pageIndex % 2]!,
    children: pageIndex % 2 === 0
      ? [
          { type: 'text', variant: 'heading', text: `标题${pageIndex}` },
          { type: 'text', variant: 'body', text: `要点${pageIndex}`, bullet: true },
        ]
      : [{ type: 'card', title: `卡${pageIndex}` }],
  }
}

/** 布局树落页装配夹具：假 Office 桥（建册/落页全成功），断言可查 mock。 */
function makeLayouterOffice() {
  const generate = vi.fn(async (_input: { roomId: string }) => ({ fileEntryId: 'file-1', originalName: '季度汇报.pptx' }))
  const fillPage = vi.fn(async (_input: { fileId: string; slideIndex: number; specJson: string }) => ({ ok: true, applied: true }))
  const renderPage = vi.fn(async () => '')
  const office = {
    bridge: { generate, fillPage, renderPage },
    visualReviewer: null,
    readMaterialBlob: async () => null,
    fetchImageHead: async () => null,
  } as never
  return { office, generate, fillPage }
}

describe('createSubagentPiTools slides_draft', () => {
  /** draft/generate 两阶段串接：按 agentId 返回各自的 invocation 夹具；builder 生成 invocationId 时回调 onInvocationId。 */
  function orchestratorByAgent(handlers: Record<string, Partial<SubagentInvocation>>): SubagentOrchestrator & {
    dispatch: ReturnType<typeof vi.fn>
  } {
    return {
      dispatch: vi.fn(async (input: { agentId: string; onInvocationId?: (id: string) => void }) => {
        const invocationId = input.agentId === 'slides-planner' ? 'invocation-plan' : 'invocation-build'
        if (input.agentId === 'slides-layouter') {
          const layouterInput = (input as { input?: { pageIndex?: number } }).input
          return {
            id: `invocation-layout-${String(layouterInput?.pageIndex ?? 0)}`,
            agentDefinitionId: 'slides-layouter',
            agentRevisionId: 'r1',
            source: 'primary_agent',
            parentSessionId: 'session-1',
            parentRunId: 'run-1',
            task: '单页布局',
            input: null,
            status: 'completed',
            result: { text: '', structuredOutput: { status: 'done', tree: layouterTreeFor(layouterInput?.pageIndex ?? 0) } },
            errorCode: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }
        }
        input.onInvocationId?.(invocationId)
        return {
          id: invocationId,
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
        }
      }),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
  }

  const planFixture = {
    phase: 'draft',
    title: '季度汇报',
    narrative: '业绩回顾到下一步计划',
    pages: [
      { title: '封面', points: ['季度汇报'], materialHints: '简洁封面' },
      { title: '业绩', role: 'data', points: ['营收增长'], data: 'Q1: 1.2 亿；Q2: 1.5 亿' },
      { title: '计划', points: ['三线扩张'] },
    ],
    warnings: [],
    summary: '3 页方案',
  }

  const builderResultFixture = {
    status: 'completed',
    fileEntryId: 'file-1',
    fileName: '季度汇报.pptx',
    pages: 3,
    outline: ['封面', '业绩', '计划'],
    warnings: [],
    summary: '已生成 3 页',
  }

  /** generate 阶段读回草稿的文档快照夹具（与 readDocumentForAgent 同构）。 */
  const draftSnapshot = {
    document: { id: 'doc-draft-1', roomId: 'room-1', title: '季度汇报', version: 1 },
    blocks: [],
    markdown: '## 封面\n- 季度汇报\n\n## 业绩\n数据：Q1: 1.2 亿；Q2: 1.5 亿\n\n## 计划\n- 三线扩张\n',
  }

  it('draft：planner 产内容草稿 → 服务端落成草稿文档即停（draft_ready），不调度落页代理', async () => {
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: planFixture } },
    })
    const createSlidesDraftDocument = vi.fn(async (_input: { roomId: string; title: string; markdown: string }) => ({
      documentId: 'doc-draft-1',
      title: '季度汇报',
    }))
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      createSlidesDraftDocument,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const onUpdate = vi.fn()
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      {
        task: 'draft',
        instruction: '做一份 3 页的季度汇报',
        title: '季度汇报',
        outline: ['封面', '业绩', '计划'],
      } as never,
      undefined,
      onUpdate,
    )

    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1)
    const plannerDispatch = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(plannerDispatch).toMatchObject({ agentId: 'slides-planner', source: 'primary_agent' })
    expect(plannerDispatch.task).toBe('演示文稿内容草稿')
    const plannerInput = plannerDispatch.input as Record<string, unknown>
    expect(plannerInput).toMatchObject({
      phase: 'draft',
      instruction: '做一份 3 页的季度汇报',
      roomId: 'room-1',
      title: '季度汇报',
    })
    expect(plannerInput.outline).toEqual(['封面', '业绩', '计划'])

    expect(createSlidesDraftDocument).toHaveBeenCalledTimes(1)
    const draftInput = createSlidesDraftDocument.mock.calls[0]![0] as Record<string, unknown>
    expect(draftInput).toMatchObject({ roomId: 'room-1', title: '季度汇报' })
    expect(String(draftInput.markdown)).toContain('## 业绩')
    expect(String(draftInput.markdown)).toContain('数据：Q1: 1.2 亿；Q2: 1.5 亿')

    // 草稿实时可见：draft_ready 带全量页清单与文档定位。
    expect(onUpdate).toHaveBeenCalledTimes(1)
    const update = onUpdate.mock.calls[0]![0] as { details: Record<string, unknown> }
    expect(update.details).toMatchObject({
      stage: 'draft_ready',
      title: '季度汇报',
      totalPages: 3,
      doneCount: 0,
      documentId: 'doc-draft-1',
    })

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({
      status: 'draft_ready',
      documentId: 'doc-draft-1',
      documentTitle: '季度汇报',
      pages: 3,
    })
  })

  it('generate：读回确认稿 → arrange 编排 → builder 一口气落页（进度器布防、两跳成链）', async () => {
    const arrangePlan = {
      ...planFixture,
      phase: 'arrange',
      pages: planFixture.pages.map((page) => ({ ...page, density: 'standard' })),
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: arrangePlan } },
      'slides-builder': { result: { text: '', structuredOutput: builderResultFixture } },
    })
    const trashDraft = vi.fn(async () => {})
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      trashSlidesDraftDocument: trashDraft,
      slidesLayoutOffice: makeLayouterOffice().office,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const onUpdate = vi.fn()
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      {
        task: 'generate',
        instruction: '受众是领导，15 分钟，内容均衡',
        draftDocumentId: 'doc-draft-1',
      } as never,
      undefined,
      onUpdate,
    )

    expect(orchestrator.dispatch).toHaveBeenCalledTimes(7) // planner + 3 布局 + 3 审页
    const plannerDispatch = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(plannerDispatch.task).toBe('演示文稿编排')
    const plannerInput = plannerDispatch.input as Record<string, unknown>
    expect(plannerInput).toMatchObject({ phase: 'arrange', roomId: 'room-1', title: '季度汇报' })
    expect((plannerInput.draftPages as Array<Record<string, unknown>>)[1]).toMatchObject({
      title: '业绩',
      data: 'Q1: 1.2 亿；Q2: 1.5 亿',
    })
    // 预设风格字段已拆除（af1c1dac）：风格倾向走 instruction，不再有 style 入参。
    expect(plannerInput.style).toBeUndefined()

    const layouterDispatches = orchestrator.dispatch.mock.calls.slice(1, 4).map((call) => call[0] as Record<string, unknown>)
    expect(layouterDispatches.every((dispatch) => dispatch.agentId === 'slides-layouter' && dispatch.source === 'primary_agent')).toBe(true)
    // 两跳串接成链：布局调用挂靠编排调用之下，时间线据此呈现先后依赖。
    expect(layouterDispatches[0]!.parentRunId).toBe('invocation-plan')
    const layouterInputs = layouterDispatches.map((dispatch) => dispatch.input as Record<string, unknown>)
    expect(layouterInputs.map((input) => input.pageIndex)).toEqual([0, 1, 2])
    expect(layouterInputs.every((input) => typeof input.deckToken === 'string' && input.deckToken.length > 0)).toBe(true)

    // plan_ready + 逐页进度：编排方案一出即透传，落页进度经布防的转发器广播。
    const stages = onUpdate.mock.calls.map((call) => (call[0] as { details: Record<string, unknown> }).details.stage)
    expect(stages[0]).toBe('plan_ready')

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({
      status: 'completed',
      fileEntryId: 'file-1',
      fileName: '季度汇报.pptx',
      pages: 3,
      summary: '已生成 3 页演示文稿',
    })

    // 级联清理：落页完成即回收内容草稿（进回收站）。
    expect(trashDraft).toHaveBeenCalledTimes(1)
    expect(trashDraft).toHaveBeenCalledWith('doc-draft-1')
  })

  it('generate：素材缺口页按 imagePrompt 生图回填进 builder 收到的 plan（page_images 进度 + 二次 plan_ready）', async () => {
    const arrangePlan = {
      ...planFixture,
      phase: 'arrange',
      pages: [
        { title: '封面', density: 'sparse', points: ['季度汇报'], imagePrompt: '深蓝科技感城市天际线，横幅构图，冷色光' },
        { title: '业绩', role: 'data', density: 'dense', points: ['营收增长'], data: 'Q1: 1.2 亿', materials: [{ url: 'https://img.example.com/a.png', desc: '已有图' }] },
        { title: '计划', density: 'standard', points: ['三线扩张'] },
      ],
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: arrangePlan } },
      'slides-builder': { result: { text: '', structuredOutput: builderResultFixture } },
    })
    const generateImage = vi.fn(async (_input: { prompt: string; retryDelaysMs?: number[] }) => ({ contentHash: 'e'.repeat(64) }))
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      slidesStyle: { images: { generateImage } } as never,
      slidesLayoutOffice: makeLayouterOffice().office,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const onUpdate = vi.fn()
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
      onUpdate,
    )

    expect(generateImage).toHaveBeenCalledTimes(1)
    expect(generateImage.mock.calls[0]![0]).toMatchObject({ prompt: expect.stringContaining('城市天际线') })
    const layouterInputs = orchestrator.dispatch.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((dispatch) => dispatch.agentId === 'slides-layouter')
      .map((dispatch) => dispatch.input as Record<string, unknown>)
    expect(layouterInputs.map((input) => input.pageIndex)).toEqual([0, 1, 2])
    expect(layouterInputs[0]!.materials).toEqual([
      { url: `everroom-material://${'e'.repeat(64)}`, desc: expect.stringContaining('AI 生成配图') },
    ])
    expect(layouterInputs[1]!.materials).toEqual([{ url: 'https://img.example.com/a.png', desc: '已有图' }])
    expect(layouterInputs[2]!.materials).toBeUndefined()

    const stages = onUpdate.mock.calls.map((call) => (call[0] as { details: Record<string, unknown> }).details.stage)
    expect(stages).toEqual(['plan_ready', 'page_images', 'plan_ready'])
    const imagesUpdate = onUpdate.mock.calls[1]![0] as { details: Record<string, unknown> }
    expect(imagesUpdate.details).toMatchObject({ stage: 'page_images', totalPages: 1, doneCount: 1 })
  })

  it('generate：生图全部失败流程照常落页，缺口页保持退化', async () => {
    const arrangePlan = {
      ...planFixture,
      phase: 'arrange',
      pages: [
        { title: '封面', density: 'sparse', points: ['季度汇报'], imagePrompt: '深蓝科技感城市天际线' },
        { title: '计划', density: 'standard', points: ['三线扩张'] },
      ],
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: arrangePlan } },
      'slides-builder': { result: { text: '', structuredOutput: builderResultFixture } },
    })
    const generateImage = vi.fn(async () => { throw new Error('生图请求失败（HTTP 500）') })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      slidesStyle: { images: { generateImage } } as never,
      slidesLayoutOffice: makeLayouterOffice().office,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    expect(orchestrator.dispatch).toHaveBeenCalledTimes(5) // planner + 2 布局 + 2 审页
    const layouterInputs = orchestrator.dispatch.mock.calls.slice(1, 3).map((call) => (call[0] as Record<string, unknown>).input as Record<string, unknown>)
    expect(layouterInputs[0]!.materials).toBeUndefined()
  })

  it('generate：落页部分完成时草稿保留（便于重试），不回收', async () => {
    const arrangePlan = {
      phase: 'arrange',
      title: '季度汇报',
      pages: [
        { title: '封面', role: 'opening', density: 'sparse', points: ['季度汇报'] },
        { title: '计划', density: 'standard', points: ['三线扩张'] },
      ],
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: arrangePlan } },
    })
    const trashDraft = vi.fn(async () => {})
    const office = makeLayouterOffice()
    office.fillPage.mockImplementation(async (_input: { slideIndex: number }) =>
      _input.slideIndex === 1 ? { ok: false, applied: false, error: '桌面端拒绝' } : { ok: true, applied: true })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      trashSlidesDraftDocument: trashDraft,
      slidesLayoutOffice: office.office,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('partial')
    expect(payload.pages).toBe(1)
    expect(payload.warnings.join('\n')).toContain('第 2 页落页失败')
    expect(trashDraft).not.toHaveBeenCalled()
  })

  it('generate：缺少 draftDocumentId 或草稿解析不到页结构即返回 failed，不发生调度', async () => {
    const orchestrator = orchestratorReturning({})
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => ({ ...draftSnapshot, markdown: '被清空的文档' }),
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    const missingId = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成' } as never,
      undefined,
    )
    expect(JSON.parse((missingId as { content: string }).content)).toMatchObject({
      status: 'failed',
      errorCode: 'slides_draft_document_required',
    })

    const emptyDraft = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    expect(JSON.parse((emptyDraft as { content: string }).content)).toMatchObject({
      status: 'failed',
      errorCode: 'slides_draft_document_empty',
    })
    expect(orchestrator.dispatch).not.toHaveBeenCalled()
  })

  it('generate：编排阶段失败即返回 failed，不发生落页调度', async () => {
    const orchestrator = orchestratorByAgent({
      'slides-planner': {
        status: 'timed_out',
        errorCode: 'timeout',
      },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '做一份季度汇报', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1)
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({ status: 'failed', retryable: true })
    expect(payload.message).toContain('编排阶段未完成')
  })

  it('generate：方案代理未注册时返回 failed，不发生调度', async () => {
    const orchestrator = orchestratorReturning({})
    const tools = createSubagentPiTools(registryWith(['slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '做一份季度汇报', draftDocumentId: 'doc-draft-1' } as never,
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

describe('createSubagentPiTools slides_draft 风格阶段', () => {
  const stylePlanParams = {
    palette: {
      background: '#f5f2ec', surface: '#faf9f6', primary: '#1e3a5f', accent: '#e0a03c',
      text: '#2f2b28', textMuted: '#8f8a81', onDarkText: '#f2f4f7',
      chartSeries: ['#1e3a5f', '#5a6f8a', '#8fa1b8', '#e0a03c', '#e8bd88'],
    },
    typography: {
      fontHeading: 'PingFang SC', fontBody: 'PingFang SC',
      sizes: { coverTitle: 64, sectionTitle: 40, pageTitle: 28, subtitle: 18, body: 14, caption: 11, kpi: 44, table: 13 },
      headingBold: true,
    },
    spacing: { margin: 60, gutter: 20, cardPadding: 16, cornerRadius: 8 },
    decoration: { cardStroke: null, cardStrokeWidthPt: 0.75, cardShadow: 'none', divider: 'line', imageFit: 'cover' },
    motif: { kind: 'none', spec: {} },
    layoutHints: {},
    darkCover: true,
    effectLines: ['主色 深藏青 #1E3A5F'],
  }

  function syntheticOverviewPng(): Buffer {
    const canvas = createCanvas(320, 180)
    const context = canvas.getContext('2d')
    context.fillStyle = '#f5f2ec'
    context.fillRect(0, 0, 320, 180)
    context.fillStyle = '#1e3a5f'
    context.fillRect(0, 0, 320, 52)
    context.fillStyle = '#e0a03c'
    context.fillRect(248, 70, 56, 100)
    return canvas.toBuffer('image/png')
  }

  const databases: DatabaseClient[] = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    databases.splice(0).forEach((database) => database.sqlite.close())
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  async function setupStyleDeps(options: {
    settleOutput?: Record<string, unknown> | null
    directionOutput?: Record<string, unknown> | null
  } = {}): Promise<{
    deps: SlidesStyleStageDeps
    orchestrator: SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
    generateImages: ReturnType<typeof vi.fn>
    saveDemoPng: ReturnType<typeof vi.fn>
  }> {
    const dir = await mkdtemp(join(tmpdir(), 'nxcore-style-stage-test-'))
    temporaryDirectories.push(dir)
    const database = createDatabase(join(dir, 'gateway.sqlite'), resolve('drizzle'))
    databases.push(database)
    const generateImages = vi.fn(async (input: { candidates: Array<{ label?: string; prompt: string }>; idempotencyKey: string }) =>
      input.candidates.map((candidate, index) => ({
        contentHash: `${input.idempotencyKey}:${String(index)}`.padEnd(64, '0').slice(0, 64),
        fileEntryId: `entry-${String(index)}`,
        index,
      })))
    const saveDemoPng = vi.fn(async () => ({ contentHash: 'd'.repeat(64), fileEntryId: 'demo-entry' }))
    const deps: SlidesStyleStageDeps = {
      sessions: new SlidesStyleSessionStore(database.db),
      images: { generateOverviewImages: generateImages } as unknown as SlidesStyleImageGenerator,
      vlm: {
        model: 'test-vlm',
        analyze: async () => ({ serif: false, weight: 'bold', geometric: 'neutral', rounded: false }),
      },
      readMaterialBytes: async () => ({ buffer: syntheticOverviewPng(), mime: 'image/png' }),
      demoRenderer: {
        renderPptx: async () => {
          throw new Error('office_bridge_unavailable')
        },
      },
      saveDemoPng,
      resolveDraftDocument: () => ({
        markdown: '## 封面\n- 季度汇报\n\n## 业绩\n数据：bar | categories: Q1 | 营收: 1\n\n## 结尾\n- 谢谢\n',
      }),
    }
    const dispatchHandlers: Record<string, Partial<SubagentInvocation>> = {
      'slides-styler': {
        result: {
          text: '',
          structuredOutput: options.settleOutput ?? options.directionOutput ?? null,
        },
      },
    }
    const orchestrator = {
      dispatch: vi.fn(async (input: { agentId: string; task?: string; input?: { task?: string }; onInvocationId?: (id: string) => void }) => {
        const invocationId = `invocation-${input.agentId}`
        input.onInvocationId?.(invocationId)
        if (input.agentId === 'slides-styler' && input.input?.task === 'settle') {
          return {
            id: 'invocation-styler', agentDefinitionId: 'slides-styler', agentRevisionId: 'r1',
            source: 'primary_agent', parentSessionId: 'session-1', parentRunId: 'run-1',
            task: '风格参数复核', input: null, status: 'completed',
            result: { text: '', structuredOutput: { task: 'settle', styleParams: stylePlanParams, notes: '' } },
            errorCode: null, errorMessage: null,
            createdAt: '', startedAt: '', completedAt: '',
          }
        }
        return {
          id: 'invocation-styler', agentDefinitionId: 'slides-styler', agentRevisionId: 'r1',
          source: 'primary_agent', parentSessionId: 'session-1', parentRunId: 'run-1',
          task: '纵览图生图提示词', input: null, status: 'completed',
          result: { text: '', structuredOutput: options.directionOutput ?? null },
          errorCode: null, errorMessage: null,
          createdAt: '', startedAt: '', completedAt: '',
        }
      }),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
    void dispatchHandlers
    return { deps, orchestrator, generateImages, saveDemoPng }
  }

  it('style：styler 出 3 条差异化提示词 → 各自生图 → 广播挑图卡并落库会话', async () => {
    const { deps, orchestrator, generateImages } = await setupStyleDeps({
      directionOutput: {
        task: 'direction',
        candidates: [
          { label: '深空科技', imagePrompt: '一张深色科技风 PPT 风格参考图，16:9 横版，深炭黑底亮青主色，顶部标题区用灰色假字条……'.repeat(2) },
          { label: '冷灰商务', imagePrompt: '一张浅色商务风 PPT 风格参考图，16:9 横版，灰白底藏蓝主色，顶部标题区用灰色假字条……'.repeat(2) },
          { label: '暖调编辑', imagePrompt: '一张暖色人文风 PPT 风格参考图，16:9 横版，米白底赭棕主色，顶部标题区用灰色假字条……'.repeat(2) },
        ],
      },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      slidesStyle: deps,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const onUpdate = vi.fn()

    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '做一份商务科技风的汇报', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
      onUpdate,
    )

    const payload = JSON.parse(result.content as string) as { status: string; styleSessionId: string; candidates: number }
    expect(payload.status).toBe('style_images_ready')
    expect(payload.candidates).toBe(3)
    // 每张候选各用自己的提示词（差异化机制），三条互不相同。
    const genInput = generateImages.mock.calls[0]?.[0] as { candidates: Array<{ label: string; prompt: string }> }
    const prompts = genInput.candidates.map((candidate) => candidate.prompt)
    expect(prompts).toHaveLength(3)
    expect(new Set(prompts).size).toBe(3)
    const broadcast = onUpdate.mock.calls.at(-1)?.[0] as { details: { stage: string; candidates: Array<{ url: string; label?: string }> } }
    expect(broadcast.details.stage).toBe('style_images_ready')
    expect(broadcast.details.candidates).toHaveLength(3)
    expect(broadcast.details.candidates.map((candidate) => candidate.label)).toEqual(['深空科技', '冷灰商务', '暖调编辑'])
    expect(broadcast.details.candidates[0]?.url.startsWith('everroom-material://')).toBe(true)
    expect(generateImages).toHaveBeenCalledTimes(1)
    const session = deps.sessions.byId(payload.styleSessionId)
    expect(session?.stage).toBe('images_ready')
    expect(session?.draftDocumentId).toBe('doc-draft-1')
  })

  it('style：styler 只回 2 条有效候选 → 兜底变体补足 3 条且告警', async () => {
    const { deps, orchestrator, generateImages } = await setupStyleDeps({
      directionOutput: {
        task: 'direction',
        candidates: [
          { label: '深空科技', imagePrompt: '一张深色科技风 PPT 风格参考图，16:9 横版，深炭黑底亮青主色，顶部标题区用灰色假字条……'.repeat(2) },
          { label: '冷灰商务', imagePrompt: '一张浅色商务风 PPT 风格参考图，16:9 横版，灰白底藏蓝主色，顶部标题区用灰色假字条……'.repeat(2) },
          { label: '', imagePrompt: '太短' },
        ],
      },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      slidesStyle: deps,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '做一份商务科技风的汇报', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )

    const payload = JSON.parse(result.content as string) as { candidates: number; warnings?: string[] }
    expect(payload.candidates).toBe(3)
    expect(payload.warnings).toEqual(['风格提示词由默认模板生成'])
    const genInput = generateImages.mock.calls[0]?.[0] as { candidates: Array<{ label: string; prompt: string }> }
    expect(genInput.candidates).toHaveLength(3)
    // 第三条由兜底种子补足（按序取第一个）。
    expect(genInput.candidates[2]?.label).toBe('冷静商务')
    // 三条仍互不相同。
    expect(new Set(genInput.candidates.map((candidate) => candidate.prompt)).size).toBe(3)
  })

  it('style 重入：默认只重新展示候选；regenerate=true 才累积反馈并重新生成', async () => {
    const { deps, orchestrator, generateImages } = await setupStyleDeps({
      directionOutput: {
        task: 'direction',
        candidates: [
          { label: '深空科技', imagePrompt: '一张深色科技风 PPT 风格参考图，16:9 横版，版式完整……'.repeat(2) },
          { label: '冷灰商务', imagePrompt: '一张浅色商务风 PPT 风格参考图，16:9 横版，版式完整……'.repeat(2) },
          { label: '暖调编辑', imagePrompt: '一张暖色人文风 PPT 风格参考图，16:9 横版，版式完整……'.repeat(2) },
        ],
      },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, { slidesStyle: deps })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const first = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const firstPayload = JSON.parse(first.content as string) as { styleSessionId: string }
    expect(generateImages).toHaveBeenCalledTimes(1)

    // 重入不带 regenerate：不生图、轮次不变，只重新广播候选。
    const reShow = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '继续' } as never,
      undefined, undefined,
    )
    const reShowPayload = JSON.parse(reShow.content as string) as { styleSessionId: string; generation: number; candidates: number }
    expect(reShowPayload.styleSessionId).toBe(firstPayload.styleSessionId)
    expect(reShowPayload.generation).toBe(1)
    expect(reShowPayload.candidates).toBe(3)
    expect(generateImages).toHaveBeenCalledTimes(1)

    // 明确不满意：regenerate=true → 反馈累积、轮次 +1、重出候选。
    const second = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '不要太蓝，要更商务', regenerate: true } as never,
      undefined, undefined,
    )
    const secondPayload = JSON.parse(second.content as string) as { styleSessionId: string; generation: number }
    expect(secondPayload.styleSessionId).toBe(firstPayload.styleSessionId)
    expect(secondPayload.generation).toBe(2)
    const session = deps.sessions.byId(secondPayload.styleSessionId)
    expect(session?.feedback).toEqual(['不要太蓝，要更商务'])
    const secondCall = generateImages.mock.calls[1]?.[0] as { idempotencyKey: string }
    expect(secondCall.idempotencyKey).toContain(':gen:2')
  })

  it('style：同 Room 换草稿不复用旧会话——按新草稿新建（复用会让 generate 读错草稿文档）', async () => {
    const { deps, orchestrator, generateImages } = await setupStyleDeps({
      directionOutput: {
        task: 'direction',
        candidates: [
          { label: '深空科技', imagePrompt: '一张深色科技风 PPT 风格参考图，16:9 横版，版式完整……'.repeat(2) },
          { label: '冷灰商务', imagePrompt: '一张浅色商务风 PPT 风格参考图，16:9 横版，版式完整……'.repeat(2) },
          { label: '暖调编辑', imagePrompt: '一张暖色人文风 PPT 风格参考图，16:9 横版，版式完整……'.repeat(2) },
        ],
      },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, { slidesStyle: deps })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    const first = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const firstSessionId = (JSON.parse(first.content as string) as { styleSessionId: string }).styleSessionId

    // 同 Room 的新草稿：不得把旧候选重新亮出来，须按新草稿新建会话并重新生成。
    const second = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '新一版', draftDocumentId: 'doc-draft-2' } as never,
      undefined, undefined,
    )
    const secondPayload = JSON.parse(second.content as string) as { styleSessionId: string }
    expect(secondPayload.styleSessionId).not.toBe(firstSessionId)
    expect(generateImages).toHaveBeenCalledTimes(2)
    expect(deps.sessions.byId(secondPayload.styleSessionId)?.draftDocumentId).toBe('doc-draft-2')
    expect(deps.sessions.byId(firstSessionId)?.draftDocumentId).toBe('doc-draft-1')
  })

  it('style_select：提取+复核+降级演示页 → 风格卡就绪；坏序号被拒', async () => {
    const { deps, orchestrator, saveDemoPng } = await setupStyleDeps()
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, { slidesStyle: deps })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const style = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const { styleSessionId } = JSON.parse(style.content as string) as { styleSessionId: string }

    const bad = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style_select', instruction: '选定', styleSessionId, candidateIndex: 9 } as never,
      undefined, undefined,
    )
    expect((JSON.parse(bad.content as string) as { status: string }).status).toBe('failed')

    const onUpdate = vi.fn()
    const selected = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style_select', instruction: '选定', styleSessionId, candidateIndex: 2 } as never,
      undefined, onUpdate,
    )
    const payload = JSON.parse(selected.content as string) as { status: string; warnings?: string[] }
    expect(payload.status).toBe('style_card_ready')
    // 桌面渲染不可用 → 演示页降级（仍有风格卡），提示入 warnings。
    expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining('演示页渲染')]))
    expect(saveDemoPng).not.toHaveBeenCalled()
    const broadcast = onUpdate.mock.calls.at(-1)?.[0] as { details: { stage: string; swatches: Array<{ hex: string }>; demoImageUrl: string | null } }
    expect(broadcast.details.stage).toBe('style_card_ready')
    expect(broadcast.details.swatches[1]?.hex).toBe('#1e3a5f')
    expect(broadcast.details.demoImageUrl).toBeNull()
    const session = deps.sessions.byId(styleSessionId)
    expect(session?.stage).toBe('card_ready')
    expect(session?.styleParams?.palette.primary).toBe('#1e3a5f')
  })

  it('style：候选构图家族缺失/重复时确定性补位，三候选两两互异并随候选落库', async () => {
    const { deps, orchestrator, generateImages } = await setupStyleDeps({
      directionOutput: {
        task: 'direction',
        candidates: [
          { label: '深空科技', imagePrompt: '一张深色科技风 PPT 风格参考图，16:9 横版，深炭黑底亮青主色，顶部标题区用灰色假字条……'.repeat(2), composition: 'poster' },
          { label: '冷灰商务', imagePrompt: '一张浅色商务风 PPT 风格参考图，16:9 横版，灰白底藏蓝主色，顶部标题区用灰色假字条……'.repeat(2), composition: 'poster' },
          { label: '暖调编辑', imagePrompt: '一张暖色人文风 PPT 风格参考图，16:9 横版，米白底赭棕主色，顶部标题区用灰色假字条……'.repeat(2) },
        ],
      },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, { slidesStyle: deps })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '做一份商务科技风的汇报', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const payload = JSON.parse(result.content as string) as { styleSessionId: string }

    const genInput = generateImages.mock.calls[0]?.[0] as { candidates: Array<{ composition: string }> }
    const compositions = genInput.candidates.map((candidate) => candidate.composition)
    expect(compositions[0]).toBe('poster')
    expect(new Set(compositions).size).toBe(3)
    const session = deps.sessions.byId(payload.styleSessionId)
    expect(session?.overviewImages.length).toBe(3)
    expect(session?.overviewImages.every((image) => typeof image.composition === 'string')).toBe(true)
    expect(new Set(session?.overviewImages.map((image) => image.composition)).size).toBe(3)
  })

  it('style_select：settle 收到草稿页角色；composition 以用户挑中的候选为准并进效果文案', async () => {
    const { deps, orchestrator } = await setupStyleDeps({
      directionOutput: {
        task: 'direction',
        candidates: [
          { label: '深空科技', imagePrompt: '一张深色科技风 PPT 风格参考图，16:9 横版，深炭黑底亮青主色，顶部标题区用灰色假字条……'.repeat(2), composition: 'swiss' },
          { label: '冷灰商务', imagePrompt: '一张浅色商务风 PPT 风格参考图，16:9 横版，灰白底藏蓝主色，顶部标题区用灰色假字条……'.repeat(2), composition: 'poster' },
          { label: '暖调编辑', imagePrompt: '一张暖色人文风 PPT 风格参考图，16:9 横版，米白底赭棕主色，顶部标题区用灰色假字条……'.repeat(2), composition: 'editorial' },
        ],
      },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, { slidesStyle: deps })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const style = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const { styleSessionId } = JSON.parse(style.content as string) as { styleSessionId: string }
    const selected = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style_select', instruction: '选定', styleSessionId, candidateIndex: 2 } as never,
      undefined, undefined,
    )
    expect((JSON.parse(selected.content as string) as { status: string }).status).toBe('style_card_ready')

    const settleCall = (orchestrator.dispatch as ReturnType<typeof vi.fn>).mock.calls
      .find((call) => (call[0] as { input?: { task?: string } }).input?.task === 'settle')
    const settleInput = (settleCall?.[0] as { input?: Record<string, unknown> }).input
    // 预设清单已随预设库删除：settle 输入不再携带 layoutPresetIds。
    expect(settleInput?.layoutPresetIds).toBeUndefined()
    expect(settleInput?.outlineRoles).toEqual(['cover', 'table', 'closing'])

    const session = deps.sessions.byId(styleSessionId)
    expect(session?.styleParams?.composition).toBe('poster')
    expect(session?.styleParams?.effectLines.some((line) => line.startsWith('构图：海报大字'))).toBe(true)
  })

  it('generate：带 styleSessionId 时风格倾向注入布局代理；未到风格卡阶段的会话被拒', async () => {
    const { deps, orchestrator } = await setupStyleDeps()
    const planFixture = {
      phase: 'arrange', title: '季度汇报', narrative: 'n',
      pages: [{ title: '封面', role: 'cover', density: 'sparse', points: ['季度汇报'] },
        { title: '业绩', role: 'data', density: 'dense', points: ['增长'], data: 'bar | categories: Q1, Q2 | 营收: 1, 2' }],
      warnings: [], summary: '',
    }
    const buildResult = { status: 'completed', fileEntryId: 'file-1', fileName: '季度汇报.pptx', pages: 2, outline: ['封面', '业绩'], warnings: [], summary: 'ok' }
    const orchestratorTwo = {
      dispatch: vi.fn(async (input: { agentId: string; input?: { task?: string; phase?: string }; onInvocationId?: (id: string) => void }) => {
        const invocationId = input.agentId === 'slides-planner' ? 'invocation-plan' : 'invocation-build'
        if (input.agentId === 'slides-layouter') {
          const layouterInput = (input as { input?: { pageIndex?: number } }).input
          return {
            id: `invocation-layout-${String(layouterInput?.pageIndex ?? 0)}`,
            agentDefinitionId: 'slides-layouter',
            agentRevisionId: 'r1',
            source: 'primary_agent',
            parentSessionId: 'session-1',
            parentRunId: 'run-1',
            task: '单页布局',
            input: null,
            status: 'completed',
            result: { text: '', structuredOutput: { status: 'done', tree: layouterTreeFor(layouterInput?.pageIndex ?? 0) } },
            errorCode: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }
        }
        input.onInvocationId?.(invocationId)
        const result = input.agentId === 'slides-planner'
          ? { text: '', structuredOutput: planFixture }
          : { text: '', structuredOutput: buildResult }
        return {
          id: invocationId, agentDefinitionId: input.agentId, agentRevisionId: 'r1', source: 'primary_agent',
          parentSessionId: 'session-1', parentRunId: 'run-1', task: 't', input: null, status: 'completed',
          result, errorCode: null, errorMessage: null, createdAt: '', startedAt: '', completedAt: '',
        }
      }),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
    void orchestrator
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestratorTwo, {
      slidesStyle: deps,
      slidesLayoutOffice: makeLayouterOffice().office,
      resolveDocumentForDraft: () => ({
        document: { id: 'doc-draft-1', roomId: 'room-1', title: '季度汇报', version: 1 },
        blocks: [],
        markdown: '## 封面\n- 季度汇报\n\n## 业绩\n数据：bar | categories: Q1, Q2 | 营收: 1, 2\n',
      }),
      trashSlidesDraftDocument: async () => undefined,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    // 会话还在 images_ready → 拒绝。
    const style = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const { styleSessionId } = JSON.parse(style.content as string) as { styleSessionId: string }
    const early = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', styleSessionId } as never,
      undefined, undefined,
    )
    expect((JSON.parse(early.content as string) as { errorCode: string }).errorCode).toBe('slides_style_session_invalid')

    // 走到 card_ready → generate 注入 styleParams 给 builder。
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style_select', instruction: '选定', styleSessionId, candidateIndex: 1 } as never,
      undefined, undefined,
    )
    const generated = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', styleSessionId } as never,
      undefined, undefined,
    )
    expect((JSON.parse(generated.content as string) as { status: string }).status).toBe('completed')
    const layouterCalls = (orchestratorTwo.dispatch as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => (call[0] as { agentId: string }).agentId === 'slides-layouter')
    expect(layouterCalls.length).toBe(2)
    // 风格卡的风格倾向以自然语言注入布局代理（effectLines 拼进 styleBrief）。
    // 构图家族以自然语言倾向注入（决策 #4：家族词表删除，倾向走 styleBrief）。
    const styleBriefes = layouterCalls.map((call) => ((call[0] as { input?: { styleBrief?: string } }).input?.styleBrief ?? ''))
    expect(styleBriefes.every((brief) => brief.length > 0)).toBe(true)
    expect(deps.sessions.byId(styleSessionId)?.stage).toBe('confirmed')
  })

  it('generate：相邻页布局树同构 → 网关自动重排一次并告警', async () => {
    const { deps } = await setupStyleDeps()
    const arrangePlan = {
      phase: 'arrange', title: '季度汇报', narrative: 'n',
      pages: [{ title: '封面', role: 'cover', density: 'sparse', points: ['季度汇报'] },
        { title: '业绩', role: 'data', density: 'dense', points: ['增长'], data: 'bar | categories: Q1, Q2 | 营收: 1, 2' }],
      warnings: [], summary: '',
    }
    const sameTree = { role: 'content', direction: 'row', children: [{ type: 'text', variant: 'body', text: '同构内容' }] }
    const differentTree = { role: 'content', direction: 'column', children: [{ type: 'text', variant: 'body', text: '重排内容' }] }
    const orchestratorSameTree = {
      dispatch: vi.fn(async (input: { agentId: string; input?: { neighborSignatures?: string[] } }) => {
        if (input.agentId === 'slides-reviewer') {
          return {
            id: 'invocation-review', agentDefinitionId: 'slides-reviewer', agentRevisionId: 'r1', source: 'primary_agent',
            parentSessionId: 'session-1', parentRunId: 'run-1', task: '单页审阅', input: null, status: 'completed',
            result: { text: '', structuredOutput: { status: 'ok' } },
            errorCode: null, errorMessage: null, createdAt: '', startedAt: '', completedAt: '',
          };
        }
        if (input.agentId === 'slides-planner') {
          return {
            id: 'invocation-plan', agentDefinitionId: 'slides-planner', agentRevisionId: 'r1', source: 'primary_agent',
            parentSessionId: 'session-1', parentRunId: 'run-1', task: 't', input: null, status: 'completed',
            result: { text: '', structuredOutput: arrangePlan }, errorCode: null, errorMessage: null,
            createdAt: '', startedAt: '', completedAt: '',
          }
        }
        const isReroll = Array.isArray(input.input?.neighborSignatures)
        return {
          id: 'invocation-layout', agentDefinitionId: 'slides-layouter', agentRevisionId: 'r1', source: 'primary_agent',
          parentSessionId: 'session-1', parentRunId: 'run-1', task: 't', input: null, status: 'completed',
          result: { text: '', structuredOutput: { status: 'done', tree: isReroll ? differentTree : sameTree } },
          errorCode: null, errorMessage: null, createdAt: '', startedAt: '', completedAt: '',
        }
      }),
    } as unknown as SubagentOrchestrator
    const office = makeLayouterOffice()
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestratorSameTree, {
      slidesStyle: deps,
      slidesLayoutOffice: office.office,
      resolveDocumentForDraft: () => ({
        document: { id: 'doc-draft-1', roomId: 'room-1', title: '季度汇报', version: 1 },
        blocks: [],
        markdown: '## 封面\n- 季度汇报\n\n## 业绩\n数据：bar | categories: Q1, Q2 | 营收: 1, 2\n',
      }),
      trashSlidesDraftDocument: async () => undefined,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const style = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const { styleSessionId } = JSON.parse(style.content as string) as { styleSessionId: string }
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style_select', instruction: '选定', styleSessionId, candidateIndex: 1 } as never,
      undefined, undefined,
    )
    const generated = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', styleSessionId } as never,
      undefined, undefined,
    )
    const payload = JSON.parse(generated.content as string) as { status: string; warnings: string[] }
    expect(payload.status).toBe('completed')
    expect(payload.warnings.join('\n')).toContain('第 2 页与邻页结构雷同')
    const rerollCall = (orchestratorSameTree as unknown as { dispatch: ReturnType<typeof vi.fn> }).dispatch.mock.calls
      .find((call) => Array.isArray((call[0] as { input?: { neighborSignatures?: string[] } }).input?.neighborSignatures))
    expect(rerollCall).toBeDefined()
    // 重排结果重落该页：slideIndex=1 落两次。
    const appliedIndexes = office.fillPage.mock.calls.map((call) => (call[0] as { slideIndex: number }).slideIndex)
    expect(appliedIndexes.filter((index) => index === 1).length).toBe(2)
  })
  it('generate：run 无 Room 绑定（用户已退出 Room）时凭 styleSessionId 反查所属 Room', async () => {
    const { deps } = await setupStyleDeps()
    const planFixture = {
      phase: 'arrange', title: '季度汇报', narrative: 'n',
      pages: [{ title: '封面', role: 'cover', density: 'sparse', points: ['季度汇报'] },
        { title: '业绩', role: 'data', density: 'dense', points: ['增长'], data: 'bar | categories: Q1, Q2 | 营收: 1, 2' }],
      warnings: [], summary: '',
    }
    const buildResult = { status: 'completed', fileEntryId: 'file-1', fileName: '季度汇报.pptx', pages: 2, outline: ['封面', '业绩'], warnings: [], summary: 'ok' }
    const orchestratorTwo = {
      dispatch: vi.fn(async (input: { agentId: string; input?: { task?: string; phase?: string }; onInvocationId?: (id: string) => void }) => {
        const invocationId = input.agentId === 'slides-planner' ? 'invocation-plan' : 'invocation-build'
        if (input.agentId === 'slides-layouter') {
          const layouterInput = (input as { input?: { pageIndex?: number } }).input
          return {
            id: `invocation-layout-${String(layouterInput?.pageIndex ?? 0)}`,
            agentDefinitionId: 'slides-layouter',
            agentRevisionId: 'r1',
            source: 'primary_agent',
            parentSessionId: 'session-1',
            parentRunId: 'run-1',
            task: '单页布局',
            input: null,
            status: 'completed',
            result: { text: '', structuredOutput: { status: 'done', tree: layouterTreeFor(layouterInput?.pageIndex ?? 0) } },
            errorCode: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }
        }
        input.onInvocationId?.(invocationId)
        const result = input.agentId === 'slides-planner'
          ? { text: '', structuredOutput: planFixture }
          : { text: '', structuredOutput: buildResult }
        return {
          id: invocationId, agentDefinitionId: input.agentId, agentRevisionId: 'r1', source: 'primary_agent',
          parentSessionId: 'session-1', parentRunId: 'run-1', task: 't', input: null, status: 'completed',
          result, errorCode: null, errorMessage: null, createdAt: '', startedAt: '', completedAt: '',
        }
      }),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
    const office = makeLayouterOffice()
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestratorTwo, {
      slidesStyle: deps,
      slidesLayoutOffice: office.office,
      resolveDocumentForDraft: () => ({
        document: { id: 'doc-draft-1', roomId: 'room-1', title: '季度汇报', version: 1 },
        blocks: [],
        markdown: '## 封面\n- 季度汇报\n\n## 业绩\n数据：bar | categories: Q1, Q2 | 营收: 1, 2\n',
      }),
      trashSlidesDraftDocument: async () => undefined,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    const style = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const { styleSessionId } = JSON.parse(style.content as string) as { styleSessionId: string }
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'style_select', instruction: '选定', styleSessionId, candidateIndex: 1 } as never,
      undefined, undefined,
    )

    // run 无 roomId、无 activeDocument：不得抛 ROOM_SELECTION_REQUIRED，
    // Room 由风格会话反查，建册与布局调用拿到的仍是会话所属 Room。
    const generated = await slidesDraft.execute(
      { ...run } as never,
      { task: 'generate', instruction: '生成', styleSessionId } as never,
      undefined, undefined,
    )
    expect((JSON.parse(generated.content as string) as { status: string }).status).toBe('completed')
    expect(office.generate.mock.calls[0]![0]).toMatchObject({ roomId: 'room-1' })
  })
})

describe('createSubagentPiTools slides_draft 配图交互', () => {
  const arrangePlanWithGaps = {
    phase: 'arrange',
    title: '季度汇报',
    narrative: '业绩回顾',
    pages: [
      { title: '封面', density: 'sparse', points: ['季度汇报'], imagePrompt: '深蓝科技感城市天际线，横幅构图，冷色光' },
      { title: '业绩', role: 'data', density: 'dense', points: ['营收增长'], data: 'Q1: 1.2 亿' },
      { title: '计划', density: 'standard', points: ['三线扩张'], imagePrompt: '团队协作白板特写，暖光' },
    ],
    warnings: [],
    summary: '3 页方案',
  }

  const builderDone = {
    status: 'completed',
    fileEntryId: 'file-1',
    fileName: '季度汇报.pptx',
    pages: 3,
    outline: ['封面', '业绩', '计划'],
    warnings: [],
    summary: '已生成 3 页',
  }

  const draftSnapshot = {
    document: { id: 'doc-draft-1', roomId: 'room-1', title: '季度汇报', version: 1 },
    blocks: [],
    markdown: '## 封面\n- 季度汇报\n\n## 业绩\n数据：Q1: 1.2 亿\n\n## 计划\n- 三线扩张\n',
  }

  function orchestratorByAgent(handlers: Record<string, Partial<SubagentInvocation>>): SubagentOrchestrator & {
    dispatch: ReturnType<typeof vi.fn>
  } {
    return {
      dispatch: vi.fn(async (input: { agentId: string; onInvocationId?: (id: string) => void }) => {
        const invocationId = input.agentId === 'slides-planner' ? 'invocation-plan' : 'invocation-build'
        if (input.agentId === 'slides-layouter') {
          const layouterInput = (input as { input?: { pageIndex?: number } }).input
          return {
            id: `invocation-layout-${String(layouterInput?.pageIndex ?? 0)}`,
            agentDefinitionId: 'slides-layouter',
            agentRevisionId: 'r1',
            source: 'primary_agent',
            parentSessionId: 'session-1',
            parentRunId: 'run-1',
            task: '单页布局',
            input: null,
            status: 'completed',
            result: { text: '', structuredOutput: { status: 'done', tree: layouterTreeFor(layouterInput?.pageIndex ?? 0) } },
            errorCode: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }
        }
        input.onInvocationId?.(invocationId)
        return {
          id: invocationId,
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
        }
      }),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
  }

  const databases: DatabaseClient[] = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    databases.splice(0).forEach((database) => database.sqlite.close())
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  interface PageImagesSetup {
    orchestrator: SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
    generateImage: ReturnType<typeof vi.fn>;
    deps: SlidesStyleStageDeps;
    office: ReturnType<typeof makeLayouterOffice>;
  }

  async function setupPageImages(
    options: { outcomes?: Array<{ ok: true; hash: string } | { ok: false; error: Error }> } = {},
  ): Promise<PageImagesSetup> {
    const dir = await mkdtemp(join(tmpdir(), 'nxcore-page-images-test-'))
    temporaryDirectories.push(dir)
    const database = createDatabase(join(dir, 'gateway.sqlite'), resolve('drizzle'))
    databases.push(database)
    const outcomes = options.outcomes ?? []
    let call = 0
    const generateImage = vi.fn(async () => {
      const outcome = outcomes[call] ?? { ok: true, hash: `${String(call + 1)}f`.repeat(8).slice(0, 64) }
      call += 1
      if (!outcome.ok) throw outcome.error
      return { contentHash: outcome.hash }
    })
    const deps: SlidesStyleStageDeps = {
      sessions: new SlidesStyleSessionStore(database.db),
      images: { generateImage } as unknown as SlidesStyleImageGenerator,
      vlm: null,
      readMaterialBytes: async () => null,
      demoRenderer: { renderPptx: async () => { throw new Error('office_bridge_unavailable') } },
      saveDemoPng: async () => ({ contentHash: 'd'.repeat(64) }),
      pageImageSessions: new SlidesPageImageSessionStore(database.db),
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: arrangePlanWithGaps } },
      'slides-builder': { result: { text: '', structuredOutput: builderDone } },
    })
    const office = makeLayouterOffice()
    return { orchestrator, generateImage, deps, office }
  }

  function buildTools(setup: PageImagesSetup) {
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), setup.orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      trashSlidesDraftDocument: async () => {},
      slidesStyle: setup.deps,
      slidesLayoutOffice: setup.office.office,
    })
    return tools.find((tool) => tool.name === 'slides_draft')!
  }

  it('缺口页停确认卡：fresh generate 返回 page_images_confirm，会话落库，builder 未调度', async () => {
    const setup = await setupPageImages()
    const slidesDraft = buildTools(setup)
    const onUpdate = vi.fn()

    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
      onUpdate,
    )

    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(1) // 只编排未落页
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('page_images_confirm')
    expect(payload.pages).toBe(2)
    const session = setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')
    expect(session?.stage).toBe('confirm')
    expect(session?.pages).toHaveLength(2)
    expect(session?.pages[0]).toMatchObject({ pageIndex: 0, title: '封面', contentHash: null })
    const stages = onUpdate.mock.calls.map((call) => (call[0] as { details: Record<string, unknown> }).details.stage)
    expect(stages).toEqual(['plan_ready', 'page_images_confirm'])
    const confirmPayload = onUpdate.mock.calls.at(-1)?.[0] as { details: Record<string, unknown> }
    expect(confirmPayload.details).toMatchObject({ stage: 'page_images_confirm', documentId: 'doc-draft-1', totalPages: 2 })
    expect(setup.generateImage).not.toHaveBeenCalled()
  })

  it('重入只重展示：无参重调不重排不烧配额', async () => {
    const setup = await setupPageImages()
    const slidesDraft = buildTools(setup)
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(1)

    const again = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '再看下配图', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(1)
    const payload = JSON.parse((again as { content: string }).content)
    expect(payload.status).toBe('page_images_confirm')
    expect(setup.generateImage).not.toHaveBeenCalled()
  })

  it('decision=generate：串行生图转 review，会话带哈希，builder 未调度', async () => {
    const setup = await setupPageImages({ outcomes: [
      { ok: true, hash: 'a'.repeat(64) },
      { ok: true, hash: 'b'.repeat(64) },
    ] })
    const slidesDraft = buildTools(setup)
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    const onUpdate = vi.fn()
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
      onUpdate,
    )

    expect(setup.generateImage).toHaveBeenCalledTimes(2)
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('page_images_review')
    expect(payload.generated).toBe(2)
    const session = setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')
    expect(session?.stage).toBe('review')
    expect(session?.pages[0]?.contentHash).toBe('a'.repeat(64))
    expect(session?.pages[1]?.contentHash).toBe('b'.repeat(64))
    const stages = onUpdate.mock.calls.map((call) => (call[0] as { details: Record<string, unknown> }).details.stage)
    expect(stages[0]).toBe('page_images')
    expect(stages.at(-1)).toBe('page_images_review')
    const reviewPayload = onUpdate.mock.calls.at(-1)?.[0] as { details: { pages: Array<{ title?: string; url?: string }> } }
    expect(reviewPayload.details.pages[0]).toMatchObject({ title: '封面', url: `everroom-material://${'a'.repeat(64)}` })
    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(1)
  })

  it('regeneratePageImage=2：只重生那张，generation 递增重广播 review', async () => {
    const setup = await setupPageImages({ outcomes: [
      { ok: true, hash: 'a'.repeat(64) },
      { ok: true, hash: 'b'.repeat(64) },
      { ok: true, hash: 'c'.repeat(64) },
    ] })
    const slidesDraft = buildTools(setup)
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
    )

    const onUpdate = vi.fn()
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '第二张重来', draftDocumentId: 'doc-draft-1', regeneratePageImage: 2, regenerateFeedback: '要更明亮' } as never,
      undefined,
      onUpdate,
    )

    expect(setup.generateImage).toHaveBeenCalledTimes(3)
    const regenerateCall = setup.generateImage.mock.calls[2]![0] as { prompt: string }
    expect(regenerateCall.prompt).toContain('团队协作白板特写')
    expect(regenerateCall.prompt).toContain('用户反馈：要更明亮')
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('page_images_review')
    expect(payload.regenerated).toBe(2)
    expect(payload.generation).toBe(2)
    const session = setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')
    expect(session?.pages[1]?.contentHash).toBe('c'.repeat(64))
    expect(session?.generation).toBe(2)
    const reviewPayload = onUpdate.mock.calls.at(-1)?.[0] as { details: Record<string, unknown> }
    expect(reviewPayload.details.generation).toBe(2)
    expect((reviewPayload.details.pages as Array<{ url?: string }>)[1]?.url).toBe(`everroom-material://${'c'.repeat(64)}`)
  })

  it('decision=accept：builder 收到注入配图的 plan，完成后会话 resolved', async () => {
    const setup = await setupPageImages({ outcomes: [
      { ok: true, hash: 'a'.repeat(64) },
      { ok: true, hash: 'b'.repeat(64) },
    ] })
    const slidesDraft = buildTools(setup)
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
    )

    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '确认落页', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'accept' } as never,
      undefined,
    )

    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(7) // planner + 3 布局 + 3 审页
    const layouterInputs = setup.orchestrator.dispatch.mock.calls.slice(1, 4).map((call) => (call[0] as Record<string, unknown>).input as Record<string, unknown>)
    expect(layouterInputs[0]!.materials).toEqual([
      { url: `everroom-material://${'a'.repeat(64)}`, desc: expect.stringContaining('AI 生成配图') },
    ])
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('completed')
    expect(setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')?.stage).toBe('resolved')
  })

  it('decision=accept 不带 styleSessionId：靠配图会话回查仍注入风格卡（回归：桌面罐头消息不带 styleSessionId）', async () => {
    const setup = await setupPageImages({ outcomes: [
      { ok: true, hash: 'a'.repeat(64) },
    ] })
    // 预置 card_ready 风格会话（绑定同一草稿），初始 generate 带 styleSessionId——与真实流程一致。
    const styleSession = setup.deps.sessions.create({ roomId: 'room-1', draftDocumentId: 'doc-draft-1', instruction: '商务科技风' })
    setup.deps.sessions.patch(styleSession.id, {
      overviewImages: [{ contentHash: 'c'.repeat(64), composition: 'poster', generation: 1 }],
      selectedImageHash: 'c'.repeat(64),
      styleParams: { palette: { primary: '#1e3a5f' }, composition: 'poster' } as never,
      stage: 'card_ready',
    })
    const slidesDraft = buildTools(setup)
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1', styleSessionId: styleSession.id } as never,
      undefined,
    )
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
    )

    // 确认落页只带 draftDocumentId（桌面罐头消息形态）——风格卡仍必须注入 builder。
    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '确认落页', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'accept' } as never,
      undefined,
    )
    expect(JSON.parse((result as { content: string }).content)).toMatchObject({ status: 'completed' })
    // 回查到的风格卡以自然语言倾向注入布局代理（composition=poster → 海报感）。
    const layouterInputs = setup.orchestrator.dispatch.mock.calls
      .filter((call) => (call[0] as { agentId: string }).agentId === 'slides-layouter')
      .map((call) => (call[0] as { input?: { styleBrief?: string } }).input)
    expect(layouterInputs.length).toBeGreaterThan(0)
    expect(layouterInputs.every((input) => (input?.styleBrief ?? '').includes('海报感'))).toBe(true)
  })

  it('decision=skip：不生图直接落页，plan 无注入', async () => {
    const setup = await setupPageImages()
    const slidesDraft = buildTools(setup)
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '跳过', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'skip' } as never,
      undefined,
    )

    expect(setup.generateImage).not.toHaveBeenCalled()
    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(7) // planner + 3 布局 + 3 审页
    const layouterInputs = setup.orchestrator.dispatch.mock.calls.slice(1, 4).map((call) => (call[0] as Record<string, unknown>).input as Record<string, unknown>)
    expect(layouterInputs[0]!.materials).toBeUndefined()
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('completed')
  })

  it('生图全失败：返回 failed 带 skip 指引，会话留在 confirm', async () => {
    const setup = await setupPageImages({ outcomes: [
      { ok: false, error: new Error('生图中转会话不可用：需要已订阅账号且网关在线') },
      { ok: false, error: new Error('生图中转会话不可用：需要已订阅账号且网关在线') },
    ] })
    const slidesDraft = buildTools(setup)
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
    )

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('failed')
    expect(payload.errorCode).toBe('slides_page_images_generation_failed')
    expect(payload.message).toContain('skip')
    expect(setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')?.stage).toBe('confirm')
    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(1)
  })

  it('阶段冲突与会话不存在：返回 failed', async () => {
    const setup = await setupPageImages()
    const slidesDraft = buildTools(setup)

    const noSession = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'accept' } as never,
      undefined,
    )
    expect(JSON.parse((noSession as { content: string }).content)).toMatchObject({
      status: 'failed',
      errorCode: 'slides_page_images_session_invalid',
    })

    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    const conflict = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '确认', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'accept' } as never,
      undefined,
    )
    expect(JSON.parse((conflict as { content: string }).content)).toMatchObject({
      status: 'failed',
      errorCode: 'slides_page_images_stage_conflict',
    })
  })
})

describe('createSubagentPiTools slides_draft 配图打回', () => {
  const arrangePlanWithGaps = {
    phase: 'arrange',
    title: '季度汇报',
    pages: [
      { title: '封面', density: 'sparse', points: ['季度汇报'], imagePrompt: '深蓝科技感城市天际线' },
      { title: '计划', density: 'standard', points: ['三线扩张'], imagePrompt: '团队协作白板特写' },
    ],
    warnings: [],
    summary: '2 页方案',
  }

  const builderDone = {
    status: 'completed',
    fileEntryId: 'file-1',
    fileName: '季度汇报.pptx',
    pages: 2,
    outline: ['封面', '计划'],
    warnings: [],
    summary: '已生成 2 页',
  }

  const draftSnapshot = {
    document: { id: 'doc-draft-1', roomId: 'room-1', title: '季度汇报', version: 1 },
    blocks: [],
    markdown: '## 封面\n- 季度汇报\n\n## 计划\n- 三线扩张\n',
  }

  const databases: DatabaseClient[] = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    databases.splice(0).forEach((database) => database.sqlite.close())
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  async function setupToReview() {
    const dir = await mkdtemp(join(tmpdir(), 'nxcore-page-reject-test-'))
    temporaryDirectories.push(dir)
    const database = createDatabase(join(dir, 'gateway.sqlite'), resolve('drizzle'))
    databases.push(database)
    const hashes = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
    let call = 0
    const generateImage = vi.fn(async () => {
      const hash = hashes[call] ?? 'd'.repeat(64)
      call += 1
      return { contentHash: hash }
    })
    const deps: SlidesStyleStageDeps = {
      sessions: new SlidesStyleSessionStore(database.db),
      images: { generateImage } as unknown as SlidesStyleImageGenerator,
      vlm: null,
      readMaterialBytes: async () => null,
      demoRenderer: { renderPptx: async () => { throw new Error('office_bridge_unavailable') } },
      saveDemoPng: async () => ({ contentHash: 'd'.repeat(64) }),
      pageImageSessions: new SlidesPageImageSessionStore(database.db),
    }
    const orchestrator = {
      dispatch: vi.fn(async (input: { agentId: string; onInvocationId?: (id: string) => void }) => {
        const invocationId = input.agentId === 'slides-planner' ? 'invocation-plan' : 'invocation-build'
        if (input.agentId === 'slides-layouter') {
          const layouterInput = (input as { input?: { pageIndex?: number } }).input
          return {
            id: `invocation-layout-${String(layouterInput?.pageIndex ?? 0)}`,
            agentDefinitionId: 'slides-layouter',
            agentRevisionId: 'r1',
            source: 'primary_agent',
            parentSessionId: 'session-1',
            parentRunId: 'run-1',
            task: '单页布局',
            input: null,
            status: 'completed',
            result: { text: '', structuredOutput: { status: 'done', tree: layouterTreeFor(layouterInput?.pageIndex ?? 0) } },
            errorCode: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }
        }
        input.onInvocationId?.(invocationId)
        const handler = input.agentId === 'slides-planner'
          ? { result: { text: '', structuredOutput: arrangePlanWithGaps } }
          : { result: { text: '', structuredOutput: builderDone } }
        return {
          id: invocationId,
          agentDefinitionId: input.agentId,
          agentRevisionId: 'revision-1',
          source: 'primary_agent',
          parentSessionId: 'session-1',
          parentRunId: 'run-1',
          task: '演示文稿',
          input: null,
          status: 'completed',
          errorCode: null,
          errorMessage: null,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          ...handler,
        }
      }),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      trashSlidesDraftDocument: async () => {},
      slidesStyle: deps,
      slidesLayoutOffice: makeLayouterOffice().office,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
    )
    return { orchestrator, generateImage, deps, slidesDraft }
  }


  it('打回第 1 张：会话标记 + 载荷带 rejected + builder 未调度', async () => {
    const { orchestrator, deps, slidesDraft } = await setupToReview()
    const onUpdate = vi.fn()

    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '打回第一张', draftDocumentId: 'doc-draft-1', rejectPageImage: 1 } as never,
      undefined,
      onUpdate,
    )

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('page_images_review')
    expect(payload.rejected).toBe(1)
    const session = deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')
    expect(session?.pages[0]?.rejected).toBe(true)
    expect(session?.pages[1]?.rejected).toBeFalsy()
    const reviewPayload = onUpdate.mock.calls.at(-1)?.[0] as { details: { pages: Array<{ rejected?: boolean }> } }
    expect(reviewPayload.details.pages[0]?.rejected).toBe(true)
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1)
  })

  it('打回后 accept：打回页 materials 被剥、其余页保留', async () => {
    const { orchestrator, generateImage, slidesDraft } = await setupToReview()
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '打回', draftDocumentId: 'doc-draft-1', rejectPageImage: 1 } as never,
      undefined,
    )

    const result = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '确认落页', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'accept' } as never,
      undefined,
    )

    expect(generateImage).toHaveBeenCalledTimes(2)
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(5) // planner + 2 布局 + 2 审页
    const layouterInputs = orchestrator.dispatch.mock.calls.slice(1, 3).map((call) => (call[0] as Record<string, unknown>).input as Record<string, unknown>)
    expect(layouterInputs[0]!.materials).toBeUndefined()
    expect(layouterInputs[1]!.materials).toEqual([
      { url: `everroom-material://${'b'.repeat(64)}`, desc: expect.stringContaining('AI 生成配图') },
    ])
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('completed')
  })

  it('恢复撤销打回；重生成该张也撤销打回', async () => {
    const { generateImage, deps, slidesDraft } = await setupToReview()
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '打回', draftDocumentId: 'doc-draft-1', rejectPageImage: 1 } as never,
      undefined,
    )

    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '恢复', draftDocumentId: 'doc-draft-1', restorePageImage: 1 } as never,
      undefined,
    )
    expect(deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')?.pages[0]?.rejected).toBeFalsy()

    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '打回', draftDocumentId: 'doc-draft-1', rejectPageImage: 2 } as never,
      undefined,
    )
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '重做', draftDocumentId: 'doc-draft-1', regeneratePageImage: 2 } as never,
      undefined,
    )
    const session = deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')
    expect(session?.pages[1]?.rejected).toBeFalsy()
    expect(session?.pages[1]?.contentHash).toBe('c'.repeat(64))
    expect(generateImage).toHaveBeenCalledTimes(3)
  })

  it('打回越界或阶段不符返回 failed', async () => {
    const { slidesDraft } = await setupToReview()
    const outOfRange = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '打回', draftDocumentId: 'doc-draft-1', rejectPageImage: 5 } as never,
      undefined,
    )
    expect(JSON.parse((outOfRange as { content: string }).content)).toMatchObject({
      status: 'failed',
      errorCode: 'slides_page_image_invalid',
    })

    const noSession = await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '打回', draftDocumentId: 'doc-draft-other', rejectPageImage: 1 } as never,
      undefined,
    )
    expect(JSON.parse((noSession as { content: string }).content)).toMatchObject({
      status: 'failed',
      errorCode: 'slides_page_images_session_invalid',
    })
  })
})

describe('createSubagentPiTools slides_draft 配图后台流水', () => {
  const arrangePlanWithGaps = {
    phase: 'arrange',
    title: '季度汇报',
    pages: [
      { title: '封面', density: 'sparse', points: ['季度汇报'], imagePrompt: '深蓝科技感城市天际线' },
      { title: '计划', density: 'standard', points: ['三线扩张'], imagePrompt: '团队协作白板特写' },
    ],
    warnings: [],
    summary: '2 页方案',
  }

  const builderDone = {
    status: 'completed',
    fileEntryId: 'file-1',
    fileName: '季度汇报.pptx',
    pages: 2,
    outline: ['封面', '计划'],
    warnings: [],
    summary: '已生成 2 页',
  }

  const draftSnapshot = {
    document: { id: 'doc-draft-1', roomId: 'room-1', title: '季度汇报', version: 1 },
    blocks: [],
    markdown: '## 封面\n- 季度汇报\n\n## 计划\n- 三线扩张\n',
  }

  const databases: DatabaseClient[] = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    databases.splice(0).forEach((database) => database.sqlite.close())
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
  }

  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => { resolve = res })
    return { promise, resolve }
  }

  async function setupBackground(options: {
    generateImage: ReturnType<typeof vi.fn>;
  }) {
    const dir = await mkdtemp(join(tmpdir(), 'nxcore-page-bg-test-'))
    temporaryDirectories.push(dir)
    const database = createDatabase(join(dir, 'gateway.sqlite'), resolve('drizzle'))
    databases.push(database)
    const runner = new SlidesPageImageRunner()
    const deps: SlidesStyleStageDeps = {
      sessions: new SlidesStyleSessionStore(database.db),
      images: { generateImage: options.generateImage } as unknown as SlidesStyleImageGenerator,
      vlm: null,
      readMaterialBytes: async () => null,
      demoRenderer: { renderPptx: async () => { throw new Error('office_bridge_unavailable') } },
      saveDemoPng: async () => ({ contentHash: 'd'.repeat(64) }),
      pageImageSessions: new SlidesPageImageSessionStore(database.db),
      pageImageRunner: runner,
    }
    const orchestrator = {
      dispatch: vi.fn(async (input: { agentId: string; onInvocationId?: (id: string) => void }) => {
        const invocationId = input.agentId === 'slides-planner' ? 'invocation-plan' : 'invocation-build'
        if (input.agentId === 'slides-layouter') {
          const layouterInput = (input as { input?: { pageIndex?: number } }).input
          return {
            id: `invocation-layout-${String(layouterInput?.pageIndex ?? 0)}`,
            agentDefinitionId: 'slides-layouter',
            agentRevisionId: 'r1',
            source: 'primary_agent',
            parentSessionId: 'session-1',
            parentRunId: 'run-1',
            task: '单页布局',
            input: null,
            status: 'completed',
            result: { text: '', structuredOutput: { status: 'done', tree: layouterTreeFor(layouterInput?.pageIndex ?? 0) } },
            errorCode: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }
        }
        input.onInvocationId?.(invocationId)
        const handler = input.agentId === 'slides-planner'
          ? { result: { text: '', structuredOutput: arrangePlanWithGaps } }
          : { result: { text: '', structuredOutput: builderDone } }
        return {
          id: invocationId,
          agentDefinitionId: input.agentId,
          agentRevisionId: 'revision-1',
          source: 'primary_agent',
          parentSessionId: 'session-1',
          parentRunId: 'run-1',
          task: '演示文稿',
          input: null,
          status: 'completed',
          errorCode: null,
          errorMessage: null,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          ...handler,
        }
      }),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      trashSlidesDraftDocument: async () => {},
      slidesStyle: deps,
      slidesLayoutOffice: makeLayouterOffice().office,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    return { orchestrator, deps, runner, slidesDraft }
  }

  async function reachReviewBackground(setup: Awaited<ReturnType<typeof setupBackground>>) {
    const { slidesDraft } = setup
    await slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    return slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
    )
  }

  it('fresh generate 自动开跑：无需 decision 即返回 review 卡且后台已生成', async () => {
    const hashes = ['a'.repeat(64), 'b'.repeat(64)]
    let call = 0
    const generateImage = vi.fn(async () => {
      const hash = hashes[call] ?? 'd'.repeat(64)
      call += 1
      return { contentHash: hash }
    })
    const setup = await setupBackground({ generateImage })

    const result = await setup.slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    // 有 runner：过目卡直接亮出（生成中占位），后台并发开跑，无需用户先决策。
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('page_images_review')
    expect(setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')?.stage).toBe('review')
    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(1) // 只编排未落页
    const sessionId = setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')!.id
    await setup.runner.settle(sessionId)
    expect(generateImage).toHaveBeenCalledTimes(2)
    const session = setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')
    expect(session?.pages[0]?.contentHash).toBe('a'.repeat(64))
    expect(session?.pages[1]?.contentHash).toBe('b'.repeat(64))
  })

  it('generate 立即返回后台生成；settle 后逐张入会话，builder 不被阻塞调度', async () => {
    const hashes = ['a'.repeat(64), 'b'.repeat(64)]
    let call = 0
    const generateImage = vi.fn(async () => {
      const hash = hashes[call] ?? 'd'.repeat(64)
      call += 1
      return { contentHash: hash }
    })
    const setup = await setupBackground({ generateImage })

    const result = await reachReviewBackground(setup)

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('page_images_review')
    expect(payload.message).toContain('后台')
    // 立即返回时可能已在生成第一张，但会话已转 review、builder 未调度。
    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(1)
    expect(setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')?.stage).toBe('review')

    const sessionId = setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')!.id
    await setup.runner.settle(sessionId)
    const session = setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')
    expect(session?.pages[0]?.contentHash).toBe('a'.repeat(64))
    expect(session?.pages[1]?.contentHash).toBe('b'.repeat(64))
    expect(generateImage).toHaveBeenCalledTimes(2)
  })

  it('生成中 accept：取消剩余，未完成页无图落页；迟到的生成结果被丢弃', async () => {
    const gate = deferred<{ contentHash: string }>()
    const generateImage = vi.fn(() => gate.promise)
    const setup = await setupBackground({ generateImage })
    await reachReviewBackground(setup)

    const result = await setup.slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '确认落页', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'accept' } as never,
      undefined,
    )

    expect(JSON.parse((result as { content: string }).content)).toMatchObject({ status: 'completed' })
    const layouterInputs = setup.orchestrator.dispatch.mock.calls
      .filter((call) => (call[0] as { agentId: string }).agentId === 'slides-layouter')
      .map((call) => (call[0] as { input?: Record<string, unknown> }).input)
    expect(layouterInputs.length).toBe(2)
    expect(layouterInputs[0]?.materials).toBeUndefined()
    expect(setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')?.stage).toBe('resolved')

    // 迟到的后台生成结果：会话已 resolved，写入被丢弃。
    gate.resolve({ contentHash: 'c'.repeat(64) })
    const sessionId = 'stale'
    void sessionId
    await new Promise((resolve) => setTimeout(resolve, 10))
    const session = setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')
    expect(session?.pages.every((page) => !page.contentHash)).toBe(true)
  })

  it('生成中单页失败打标记继续下一页；失败页可重生成', async () => {
    const hashes = ['a'.repeat(64)]
    let call = 0
    const generateImage = vi.fn(async () => {
      call += 1
      if (call === 1) throw new Error('生图请求失败（HTTP 500）')
      return { contentHash: hashes[call - 2] ?? 'b'.repeat(64) }
    })
    const setup = await setupBackground({ generateImage })
    await reachReviewBackground(setup)

    const sessionId = setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')!.id
    await setup.runner.settle(sessionId)
    const session = setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')
    expect(session?.pages[0]?.failed).toBe(true)
    expect(session?.pages[0]?.contentHash).toBeNull()
    expect(session?.pages[1]?.contentHash).toBe('a'.repeat(64))

    const result = await setup.slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '补第一张', draftDocumentId: 'doc-draft-1', regeneratePageImage: 1 } as never,
      undefined,
    )
    expect(JSON.parse((result as { content: string }).content)).toMatchObject({ status: 'page_images_review' })
    expect(setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')?.pages[0]?.failed).toBeFalsy()
  })

  it('review 阶段 skip：取消后台并剥掉已生成的图', async () => {
    const hashes = ['a'.repeat(64), 'b'.repeat(64)]
    let call = 0
    const generateImage = vi.fn(async () => {
      const hash = hashes[call] ?? 'd'.repeat(64)
      call += 1
      return { contentHash: hash }
    })
    const setup = await setupBackground({ generateImage })
    await reachReviewBackground(setup)
    const sessionId = setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')!.id
    await setup.runner.settle(sessionId)

    const result = await setup.slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '不要配图了', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'skip' } as never,
      undefined,
    )

    expect(JSON.parse((result as { content: string }).content)).toMatchObject({ status: 'completed' })
    const layouterInputs = setup.orchestrator.dispatch.mock.calls
      .filter((call) => (call[0] as { agentId: string }).agentId === 'slides-layouter')
      .map((call) => (call[0] as { input?: Record<string, unknown> }).input)
    expect(layouterInputs.map((input) => input?.materials).every((materials) => materials === undefined)).toBe(true)
  })

  it('生成中重生成已出的页：与后台循环互不覆盖', async () => {
    const hashes = ['a'.repeat(64)]
    const slowGate = deferred<{ contentHash: string }>()
    let slowCall = 0
    const generateImage = vi.fn(async (input: { prompt: string }) => {
      if (input.prompt.includes('白板')) {
        slowCall += 1
        return slowGate.promise
      }
      return { contentHash: hashes[0]! }
    })
    const setup = await setupBackground({ generateImage })
    await reachReviewBackground(setup)
    // 第一张（封面）后台即出；第二张（白板）卡在慢门上。

    const regen = await setup.slidesDraft.execute(
      { ...run, roomId: 'room-1' } as never,
      { task: 'generate', instruction: '封面重做', draftDocumentId: 'doc-draft-1', regeneratePageImage: 1, regenerateFeedback: '更亮' } as never,
      undefined,
    )
    expect(JSON.parse((regen as { content: string }).content)).toMatchObject({
      status: 'page_images_review',
      generation: 2,
    })

    slowGate.resolve({ contentHash: 'b'.repeat(64) })
    const sessionId = setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')!.id
    await setup.runner.settle(sessionId)
    const session = setup.deps.pageImageSessions!.byDraftId('room-1', 'doc-draft-1')
    // 重生成的新封面哈希（a）未被后台循环覆盖；慢门页拿到自己的哈希（b）。
    expect(session?.pages[0]?.contentHash).toBe('a'.repeat(64))
    expect(session?.pages[1]?.contentHash).toBe('b'.repeat(64))
    expect(session?.generation).toBe(2)
  })
})
