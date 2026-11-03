import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import type { SubagentInvocation } from '@nxcore/agent-contract'
import { Ajv } from 'ajv'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SubagentOrchestrator } from '../src/modules/subagents/orchestrator.js'
import type { SubagentRegistry } from '../src/modules/subagents/registry.js'
import { createSubagentPiTools } from '../src/modules/subagents/tools.js'
import type { SlidesStyleStageDeps } from '../src/modules/subagents/slides-style-stage.js'
import type { SlidesStyleImageGenerator } from '../src/modules/slides-style/image-gen.js'
import { SlidesStyleSessionStore } from '../src/modules/slides-style/style-session.js'
import { SlidesPageImageSessionStore } from '../src/modules/subagents/slides-page-images-store.js'
import { SlidesPageImageRunner } from '../src/modules/subagents/slides-page-images-runner.js'
import { SlidesGenerationCheckpointStore } from '../src/modules/subagents/slides-generation-checkpoints.js'
import { decidePageImages } from '../src/modules/subagents/slides-page-images-stage.js'
import type { DatabaseClient } from '../src/infrastructure/database/client.js'
import { createDatabase } from '../src/infrastructure/database/client.js'
import { withSemanticContent } from './fixtures/slides-semantic.js'

function registryWith(agentIds: string[]): SubagentRegistry {
  // 单一产出路径：generate 落页必须先有 editor 的 storyboard，注册表里始终放 slides-editor。
  const ids = agentIds.includes('slides-editor') ? agentIds : [...agentIds, 'slides-editor']
  return {
    get: (id: string) => (ids.includes(id) ? { id } : null),
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

describe('createSubagentPiTools room_analysis', () => {
  it('不再注册 room_analysis（Phase 1 已摘除 Room 材料投影链路）', () => {
    const tools = createSubagentPiTools(registryWith(['content-analyst']), orchestratorReturning({}))
    expect(tools.map((tool) => tool.name)).not.toContain('room_analysis')
    // 纯投喂的 content_analysis 仍在，材料分析能力没有随 Room 一起消失。
    expect(tools.map((tool) => tool.name)).toContain('content_analysis')
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
      : [{ type: 'text', variant: 'heading', text: `标题${pageIndex}` }],
  }
}

/** 布局树落页装配夹具：假 Office 桥（建册/落页全成功），断言可查 mock。
 * 语义链路下树节点必须承载 content.blocks 的真实文案（载荷绑定校验按文本比对），
 * 所以带 content 的输入直接用 block 文本渲染节点；无 content 时回退固定形状。 */
function v2TreeFor(pageIndex: number, content?: { blocks?: Array<{ id?: string; type?: string; text?: string }>; role?: string }): Record<string, unknown> | null {
  if (content?.blocks?.length) {
    return {
      version: 2,
      role: content.role ?? 'content',
      composition: 'swiss',
      nodes: content.blocks.map((block, index) => ({
        type: 'text',
        token: index === 0 ? 'h1' : 'body',
        text: block.text ?? `第 ${pageIndex + 1} 页`,
        slot: { col: [1, 12], row: [index + 1, index + 2] },
      })),
    };
  }
  return null;
}

/** 语义模式布局结果：树节点承载 block 文案 + bindings 逐块指认。 */
function layouterResultFor(pageIndex: number, content?: { blocks?: Array<{ id?: string; type?: string; text?: string }>; role?: string }): Record<string, unknown> {
  const tree = v2TreeFor(pageIndex, content);
  if (tree && content?.blocks) {
    return { status: 'done', tree, designIntent: '标题与全部要点', bindings: content.blocks.map((block, index) => ({ blockId: block.id ?? `block-${index}`, paths: [`nodes/${index}`] })) };
  }
  return { status: 'done', tree: v2LegacyTreeFor(pageIndex) };
}

function v2LegacyTreeFor(pageIndex: number): Record<string, unknown> {
  if (pageIndex === 0) {
    return {
      version: 2,
      role: 'cover',
      composition: 'poster',
      nodes: [
        { type: 'image', url: 'everroom-material://' + 'a'.repeat(64), fit: 'cover', bleed: true, slot: { col: [1, 12], row: [1, 8] } },
        { type: 'text', token: 'display', text: '第 1 页', tone: 'inverse', slot: { col: [1, 8], row: [5, 6] } },
      ],
    };
  }
  if (pageIndex === 1) {
    return {
      version: 2,
      role: 'data',
      composition: 'hero-data',
      nodes: [
        { type: 'text', token: 'h1', text: '数据页', slot: { col: [1, 8], row: [1, 1] } },
        { type: 'text', token: 'hero', text: '2.7', slot: { col: [1, 4], row: [2, 4] } },
        { type: 'stats', items: [{ value: '1.2', unit: '亿', label: 'Q1' }, { value: '1.5', unit: '亿', label: 'Q2' }], slot: { col: [5, 8], row: [2, 4] } },
        { type: 'text', token: 'caption', text: 'SOURCE: BP', slot: { col: [1, 8], row: [8, 8] } },
      ],
    };
  }
  return {
    version: 2,
    role: 'content',
    composition: 'swiss',
    nodes: [
      { type: 'text', token: 'h1', text: `第 ${pageIndex + 1} 页`, slot: { col: [1, 8], row: [1, 2] } },
      { type: 'text', token: 'body', text: '正文要点', slot: { col: [1, 8], row: [3, 5] } },
      { type: 'shape', shape: 'rect', fill: '#2F5BFF', slot: { col: [1, 2], row: [8, 8] } },
      { type: 'text', token: 'caption', text: 'SOURCE: BP', slot: { col: [8, 12], row: [8, 8] } },
    ],
  };
}

/** 从 planner 草稿页合成 storyboard/v2（测试夹具：与 editor 的真实产物同形）。 */
function storyboardForDraftPages(
  editorInput: { draftPages?: Array<{ title?: string; points?: string[]; data?: string }>; deckStyle?: { composition?: string } } | undefined,
): Record<string, unknown> {
  const draftPages = editorInput?.draftPages ?? []
  return {
    schemaVersion: 'storyboard/v2',
    deck: { title: '季度汇报', spine: '从业绩回顾到下一步计划' },
    pages: draftPages.map((page, index) => ({
      id: `page-${String(index + 1).padStart(2, '0')}`,
      role: index === 0 ? 'cover' : (page.data ? 'data' : 'content'),
      density: 'standard',
      form: index === 0 ? 'light-page' : (page.data ? 'single-fact' : 'breakdown'),
      units: index === 0 || page.data ? 1 : 3,
      weight: index === 0 ? 'heavy' : 'medium',
      emphasis: page.data ? 'number' : 'title',
      intent: `第 ${index + 1} 页说明一件事。`,
      takeaway: page.title ?? `第 ${index + 1} 页`,
      copy: {
        message: page.title ?? `第 ${index + 1} 页`,
        supporting: (page.points ?? []).slice(0, 1),
        facts: [],
        speakerNotes: `第 ${index + 1} 页讲稿：这一页只讲一件事，先给结论再给依据，留出停顿。`.repeat(3),
      },
      ...(page.data ? { data: { stats: [{ value: '1.2', unit: '亿', label: page.title ?? '指标' }] } } : {}),
      dropped: [],
    })),
    warnings: [],
  }
}

function makeLayouterOffice() {
  const generate = vi.fn(async (_input: { roomId: string | null }) => ({ fileEntryId: 'file-1', originalName: '季度汇报.pptx' }))
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
  type TestHandler = Partial<SubagentInvocation> | ((input: Record<string, unknown>) => Partial<SubagentInvocation>)
  function orchestratorByAgent(handlers: Record<string, TestHandler>): SubagentOrchestrator & {
    dispatch: ReturnType<typeof vi.fn>
  } {
    let plannerCalls = 0
    return {
      dispatch: vi.fn(async (input: { agentId: string; onInvocationId?: (id: string) => void }) => {
        let invocationId = input.agentId === 'slides-planner' ? 'invocation-plan' : 'invocation-build'
        if (input.agentId === 'slides-planner') {
          plannerCalls += 1
          if (plannerCalls > 1) invocationId = `invocation-plan-${plannerCalls}`
        }
        if (input.agentId === 'slides-editor' && !handlers['slides-editor']) {
          const editorInput = (input as { input?: { draftPages?: Array<{ title?: string; points?: string[] }>; deckStyle?: { composition?: string } } }).input
          const storyboard = storyboardForDraftPages(editorInput)
          return {
            id: 'invocation-editor',
            agentDefinitionId: 'slides-editor',
            agentRevisionId: 'revision-1',
            source: 'primary_agent',
            parentSessionId: 'session-1',
            parentRunId: 'run-1',
            task: '演示文稿压缩编排',
            input: null,
            status: 'completed',
            result: { text: '', structuredOutput: storyboard },
            errorCode: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }
        }
        if (input.agentId === 'slides-layouter') {
          const layouterInput = (input as { input?: { pageIndex?: number; layoutVersion?: number; content?: { blocks?: Array<{ type?: string; text?: string }>; role?: string } } }).input
          const structured = layouterInput?.layoutVersion === 2
            ? layouterResultFor(layouterInput.pageIndex ?? 0, layouterInput?.content)
            : { status: 'done', tree: layouterTreeFor(layouterInput?.pageIndex ?? 0) }
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
            result: { text: '', structuredOutput: structured as Record<string, unknown> },
            errorCode: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }
        }
        input.onInvocationId?.(invocationId)
        const handler = handlers[input.agentId]
        const extra = typeof handler === 'function' ? handler(input as unknown as Record<string, unknown>) : handler
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
          ...extra,
        }
      }),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
  }

  /** 块 1 各 generate 测试共用的草稿 markdown（= draftSnapshot.markdown，来源 hash 依据）。 */
  const DRAFT_MD_MAIN = '## 封面\n- 季度汇报\n\n## 业绩\n数据：Q1: 1.2 亿；Q2: 1.5 亿\n\n## 计划\n- 三线扩张\n'

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

  it('工具 schema 按 task 隔离字段，并允许无 instruction 的生成续接', () => {
    const slidesDraft = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestratorReturning({}))
      .find((tool) => tool.name === 'slides_draft')!
    const validate = new Ajv({ strict: false, allErrors: true }).compile(slidesDraft.parameters)

    expect(validate({ task: 'draft', instruction: '做一份季度汇报', outline: ['封面'] })).toBe(true)
    expect(validate({ task: 'style_select', styleSessionId: 'style-1', candidateIndex: 2 })).toBe(true)
    expect(validate({ task: 'generate', draftDocumentId: 'draft-1', pageImagesDecision: 'accept' })).toBe(true)
    expect(validate({ task: 'generate', styleSessionId: 'style-1', pageImagesDecision: 'accept' })).toBe(true)
    // 无 id 裸 generate 合法：对话路径拿不到 id 时网关按最新风格会话自动恢复。
    expect(validate({ task: 'generate', pageImagesDecision: 'accept' })).toBe(true)
    // 试看：previewPages 只落前 N 页，草稿与风格保留。
    expect(validate({ task: 'generate', draftDocumentId: 'draft-1', previewPages: 2 })).toBe(true)
    expect(validate({ task: 'generate', draftDocumentId: 'draft-1', previewPages: 32 })).toBe(true)
    expect(validate({ task: 'generate', draftDocumentId: 'draft-1', previewPages: 33 })).toBe(false)
    // 整轮重生成：复用上一轮方案与 deck 文件重排落页。
    expect(validate({ task: 'generate', draftDocumentId: 'draft-1', regenerateDeck: true })).toBe(true)
    // 指定页重生成：只重排这些页。
    expect(validate({ task: 'generate', draftDocumentId: 'draft-1', regeneratePages: [2] })).toBe(true)
    expect(validate({ task: 'generate', draftDocumentId: 'draft-1', regeneratePages: [] })).toBe(false)
    expect(validate({ task: 'edit', instruction: '放大标题', fileId: 'file-1' })).toBe(true)
    expect(validate({ task: 'edit', instruction: '放大标题', rejectPageImage: 2 })).toBe(false)
    expect(validate({ task: 'style_select', styleSessionId: 'style-1', candidateIndex: 2, instruction: '选这个' })).toBe(false)
  })

  it('draft：planner 产内容草稿 → 服务端落成草稿文档即停（draft_ready），不调度落页代理', async () => {
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: planFixture } },
    })
    const createSlidesDraftDocument = vi.fn(async (_input: { title: string; markdown: string }) => ({
      documentId: 'doc-draft-1',
      title: '季度汇报',
    }))
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      createSlidesDraftDocument,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const onUpdate = vi.fn()
    const result = await slidesDraft.execute(
      run as never,
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
      title: '季度汇报',
    })
    // 去 Room：派发 input 不再携带 roomId。
    expect(plannerInput).not.toHaveProperty('roomId')
    expect(plannerInput.outline).toEqual(['封面', '业绩', '计划'])

    expect(createSlidesDraftDocument).toHaveBeenCalledTimes(1)
    const draftInput = createSlidesDraftDocument.mock.calls[0]![0] as Record<string, unknown>
    expect(draftInput).toMatchObject({ title: '季度汇报' })
    // 去 Room：建草稿文档只收 { title, markdown }。
    expect(draftInput).not.toHaveProperty('roomId')
    expect(String(draftInput.markdown)).toContain('## 业绩')
    expect(String(draftInput.markdown)).toContain('数据：Q1: 1.2 亿；Q2: 1.5 亿')

    // 草稿实时可见：planner 前先发 drafting，draft_ready 带全量页清单与文档定位。
    expect(onUpdate).toHaveBeenCalledTimes(2)
    const draftingUpdate = onUpdate.mock.calls[0]![0] as { details: Record<string, unknown> }
    expect(draftingUpdate.details).toMatchObject({ stage: 'drafting', title: '季度汇报' })
    expect(draftingUpdate.details).not.toHaveProperty('roomId')
    expect(typeof draftingUpdate.details.updatedAt).toBe('number')
    const update = onUpdate.mock.calls[1]![0] as { details: Record<string, unknown> }
    expect(update.details).toMatchObject({
      stage: 'draft_ready',
      title: '季度汇报',
      totalPages: 3,
      doneCount: 0,
      documentId: 'doc-draft-1',
    })
    expect(update.details).not.toHaveProperty('roomId')
    expect(typeof update.details.updatedAt).toBe('number')

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({
      status: 'draft_ready',
      documentId: 'doc-draft-1',
      documentTitle: '季度汇报',
      pages: 3,
    })
  })

  it('回归（去 Room）：run 无 roomId / availableRooms / activeDocument 时 slides_draft(task=draft) 仍能派发 planner 并返回 draft_ready', async () => {
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: planFixture } },
    })
    const createSlidesDraftDocument = vi.fn(async (_input: { title: string; markdown: string }) => ({
      documentId: 'doc-draft-1',
      title: '季度汇报',
    }))
    const slidesDraft = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      createSlidesDraftDocument,
    }).find((tool) => tool.name === 'slides_draft')!

    // 桌面渲染层已无 Room：run 只有 runId/sessionId——无 roomId、无 availableRooms、
    // 无 activeDocument。此前链路会抛 ROOM_SELECTION_REQUIRED，PPT 整条不可用。
    const bareRun = { runId: 'run-1', sessionId: 'session-1' }
    expect(bareRun).not.toHaveProperty('roomId')
    const result = await slidesDraft.execute(
      bareRun as never,
      { task: 'draft', instruction: '做一份 3 页的季度汇报', title: '季度汇报' } as never,
      undefined,
    )

    // 派发成功：不再有 Room 解析/守卫。
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1)
    const dispatch = orchestrator.dispatch.mock.calls[0]![0] as { agentId: string; input: Record<string, unknown> }
    expect(dispatch.agentId).toBe('slides-planner')
    expect(dispatch.input).not.toHaveProperty('roomId')
    expect(JSON.stringify(dispatch.input)).not.toContain('"roomId"')

    // 落草稿文档只收 { title, markdown }：草稿文档归属工作区，不归属 Room。
    expect(createSlidesDraftDocument).toHaveBeenCalledTimes(1)
    const draftInput = createSlidesDraftDocument.mock.calls[0]![0] as Record<string, unknown>
    expect(Object.keys(draftInput).sort()).toEqual(['markdown', 'title'])
    expect(draftInput).toMatchObject({ title: '季度汇报' })
    expect(String(draftInput.markdown).length).toBeGreaterThan(0)

    const payload = JSON.parse((result as { content: string }).content) as { status: string }
    expect(payload.status).toBe('draft_ready')
  })

  it('draft：指令里点名的 Room 文档正文由网关预取随输入下发，planner 不再逐篇读取', async () => {
    const documentId = '11111111-1111-4111-8111-111111111111'
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: planFixture } },
    })
    const markdown = '## 封面\n- 标题\n'.repeat(5_000)
    const resolveDocumentForDraft = vi.fn((id: string) => {
      if (id !== documentId) throw new Error('document_not_found')
      return {
        document: { id: documentId, roomId: 'room-1', title: '27 页大纲', version: 5 },
        blocks: [],
        markdown,
      }
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      createSlidesDraftDocument: async () => ({ documentId: 'doc-draft-1', title: '季度汇报' }),
      resolveDocumentForDraft,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    await slidesDraft.execute(
      run as never,
      {
        task: 'draft',
        instruction: `根据 Room 文档（文档 ID ${documentId}）生成 3 页草稿`,
        // 显式传了不存在的 id：忽略即可，不能因此让草稿失败。
        sourceDocumentIds: ['22222222-2222-4222-8222-222222222222'],
      } as never,
    )

    const plannerDispatch = orchestrator.dispatch.mock.calls[0]![0] as { input: Record<string, unknown> }
    const sourceDocuments = plannerDispatch.input.sourceDocuments as Array<Record<string, unknown>>
    expect(sourceDocuments).toHaveLength(1)
    // 单篇 40k 字符封顶，超出部分标记 truncated 并保留原始总长度。
    expect(sourceDocuments[0]).toMatchObject({
      documentId,
      title: '27 页大纲',
      version: 5,
      truncated: true,
      markdownTotalCharacters: markdown.length,
    })
    expect(String(sourceDocuments[0]!.markdown)).toHaveLength(40_000)
    expect(resolveDocumentForDraft).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222')
    expect(resolveDocumentForDraft).toHaveBeenCalledWith(documentId)
  })

  it('generate：读回确认稿 → arrange 编排 → builder 一口气落页（进度器布防、两跳成链）', async () => {
    const arrangePlan = {
      ...planFixture,
      phase: 'arrange',
      pages: withSemanticContent(DRAFT_MD_MAIN, 'doc-draft-1').map((page) => ({ ...page, density: 'standard' })),
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: arrangePlan } },
      'slides-builder': { result: { text: '', structuredOutput: builderResultFixture } },
    })
    const trashDraft = vi.fn(async () => {})
    // arrange 前置素材预取：命中随 planner 输入下发，planner 不再自己检索。
    const searchMaterials = vi.fn(() => [{
      ref: 'everroom-material://cover-photo',
      kind: 'photo' as const,
      desc: '团队合影',
      meta: '照片 1920×1080',
      rank: 4,
    }])
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      trashSlidesDraftDocument: trashDraft,
      slidesLayoutOffice: makeLayouterOffice().office,
      slidesEditor: { active: true },
      searchMaterials,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const onUpdate = vi.fn()
    const result = await slidesDraft.execute(
      run as never,
      {
        task: 'generate',
        instruction: '受众是领导，15 分钟，内容均衡',
        draftDocumentId: 'doc-draft-1',
      } as never,
      undefined,
      onUpdate,
    )

    expect(orchestrator.dispatch).toHaveBeenCalledTimes(4) // planner + 3 布局（审页代理已砍；桩无渲染桥，自审回投跳过）
    const plannerDispatch = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(plannerDispatch.task).toBe('演示文稿编排')
    const plannerInput = plannerDispatch.input as Record<string, unknown>
    expect(plannerInput).toMatchObject({ phase: 'arrange', title: '季度汇报' })
    expect(plannerInput).not.toHaveProperty('roomId')
    expect((plannerInput.draftPages as Array<Record<string, unknown>>)[1]).toMatchObject({
      title: '业绩',
      data: 'Q1: 1.2 亿；Q2: 1.5 亿',
    })
    // 预设风格字段已拆除（af1c1dac）：风格倾向走 instruction，不再有 style 入参。
    expect(plannerInput.style).toBeUndefined()
    // 素材由网关按页预取：pageIndex 与 draftPages 顺序一致，命中随输入下发。
    expect(searchMaterials).toHaveBeenCalled()
    expect(plannerInput.materialHits).toEqual([
      {
        pageIndex: 0,
        query: expect.any(String),
        hits: [{ ref: 'everroom-material://cover-photo', kind: 'photo', desc: '团队合影', meta: '照片 1920×1080' }],
      },
      {
        pageIndex: 1,
        query: expect.any(String),
        hits: [{ ref: 'everroom-material://cover-photo', kind: 'photo', desc: '团队合影', meta: '照片 1920×1080' }],
      },
      {
        pageIndex: 2,
        query: expect.any(String),
        hits: [{ ref: 'everroom-material://cover-photo', kind: 'photo', desc: '团队合影', meta: '照片 1920×1080' }],
      },
    ])

    const layouterDispatches = orchestrator.dispatch.mock.calls
      .filter((call) => (call[0] as Record<string, unknown>).agentId === 'slides-layouter')
      .map((call) => call[0] as Record<string, unknown>)
    expect(layouterDispatches.every((dispatch) => dispatch.agentId === 'slides-layouter' && dispatch.source === 'primary_agent')).toBe(true)
    // 两跳串接成链：布局调用挂靠编排调用之下，时间线据此呈现先后依赖。
    expect(layouterDispatches[0]!.parentRunId).toBe('invocation-plan')
    const layouterInputs = layouterDispatches.map((dispatch) => dispatch.input as Record<string, unknown>)
    expect(layouterInputs.map((input) => input.pageIndex)).toEqual([0, 1, 2])
    expect(layouterInputs.every((input) => typeof input.deckToken === 'string' && input.deckToken.length > 0)).toBe(true)

    // planning（arrange 前）+ plan_ready（方案一出即透传）+ 落页进度经布防的转发器广播。
    const stages = onUpdate.mock.calls.map((call) => (call[0] as { details: Record<string, unknown> }).details.stage)
    expect(stages[0]).toBe('planning')
    expect(stages[1]).toBe('plan_ready')

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

  it('generate → regenerateDeck：复用方案与同一 deck 文件重排，不再编排不再建文件', async () => {
    const arrangePlan = {
      ...planFixture,
      phase: 'arrange',
      pages: withSemanticContent(DRAFT_MD_MAIN, 'doc-draft-1').map((page) => ({ ...page, density: 'standard' })),
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: arrangePlan } },
    })
    const { office, generate, fillPage } = makeLayouterOffice()
    const trashDraft = vi.fn(async () => {})
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      trashSlidesDraftDocument: trashDraft,
      slidesLayoutOffice: office,
      slidesEditor: { active: true },
      searchMaterials: () => [],
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    const first = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '受众是领导，内容均衡', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
      vi.fn(),
    )
    expect(JSON.parse((first as { content: string }).content)).toMatchObject({ status: 'completed', fileEntryId: 'file-1' })
    expect(generate).toHaveBeenCalledTimes(1)

    orchestrator.dispatch.mockClear()
    fillPage.mockClear()
    const second = await slidesDraft.execute(
      run as never,
      { task: 'generate', draftDocumentId: 'doc-draft-1', regenerateDeck: true } as never,
      undefined,
      vi.fn(),
    )

    const payload = JSON.parse((second as { content: string }).content)
    expect(payload).toMatchObject({ status: 'completed', fileEntryId: 'file-1', fileName: '季度汇报.pptx' })
    // 不再编排：无 planner 派发，三页布局全部重跑。
    const agents = orchestrator.dispatch.mock.calls.map((call) => (call[0] as Record<string, unknown>).agentId)
    expect(agents).not.toContain('slides-planner')
    expect(agents.filter((agentId) => agentId === 'slides-layouter')).toHaveLength(3)
    // 同一 deck：不新建文件，三页全部原地重填。
    expect(generate).toHaveBeenCalledTimes(1)
    expect(fillPage).toHaveBeenCalledTimes(3)
    expect(fillPage.mock.calls.every((call) => call[0]!.fileId === 'file-1')).toBe(true)
  })

  it('generate → regeneratePages=[2]：只重排指定页，其余页保持已落定', async () => {
    const arrangePlan = {
      ...planFixture,
      phase: 'arrange',
      pages: withSemanticContent(DRAFT_MD_MAIN, 'doc-draft-1').map((page) => ({ ...page, density: 'standard' })),
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: arrangePlan } },
    })
    const { office, generate, fillPage } = makeLayouterOffice()
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      trashSlidesDraftDocument: async () => {},
      slidesLayoutOffice: office,
      slidesEditor: { active: true },
      searchMaterials: () => [],
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '受众是领导，内容均衡', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
      vi.fn(),
    )

    orchestrator.dispatch.mockClear()
    fillPage.mockClear()
    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', draftDocumentId: 'doc-draft-1', regeneratePages: [2] } as never,
      undefined,
      vi.fn(),
    )
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({ status: 'completed', fileEntryId: 'file-1' })
    // 只重排第 2 页：无编排，布局只派发一页（页序 1），其余页按已落定跳过。
    const agents = orchestrator.dispatch.mock.calls.map((call) => (call[0] as Record<string, unknown>).agentId)
    expect(agents).not.toContain('slides-planner')
    const layouterInputs = orchestrator.dispatch.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((dispatch) => dispatch.agentId === 'slides-layouter')
      .map((dispatch) => dispatch.input as Record<string, unknown>)
    expect(layouterInputs).toHaveLength(1)
    expect(layouterInputs[0]!.pageIndex).toBe(1)
    expect(fillPage).toHaveBeenCalledTimes(1)
    expect((fillPage.mock.calls[0]![0] as { slideIndex: number }).slideIndex).toBe(1)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('regeneratePages 越界：返回 failed 并给出本轮有效页码范围', async () => {
    const arrangePlan = {
      ...planFixture,
      phase: 'arrange',
      pages: withSemanticContent(DRAFT_MD_MAIN, 'doc-draft-1').map((page) => ({ ...page, density: 'standard' })),
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: arrangePlan } },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      slidesLayoutOffice: makeLayouterOffice().office,
      slidesEditor: { active: true },
      searchMaterials: () => [],
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
      vi.fn(),
    )
    orchestrator.dispatch.mockClear()
    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', draftDocumentId: 'doc-draft-1', regeneratePages: [9] } as never,
      undefined,
      vi.fn(),
    )
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({ status: 'failed', errorCode: 'slides_regenerate_pages_invalid' })
    expect(String(payload.message)).toContain('1~3')
    expect(orchestrator.dispatch).not.toHaveBeenCalled()
  })

  it('generate：试看 1 页不含封面——编排与落页都只做首个内容页，草稿保留', async () => {
    // 编排输入已按试看范围裁剪（只剩业绩页），夹具须按裁剪后的草稿算来源 hash。
    const scopedArrangePlan = {
      ...planFixture,
      phase: 'arrange',
      pages: withSemanticContent('## 业绩\n数据：Q1: 1.2 亿；Q2: 1.5 亿\n', 'doc-draft-1')
        .map((page) => ({ ...page, density: 'standard' })),
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: scopedArrangePlan } },
    })
    const trashDraft = vi.fn(async () => {})
    const { office, generate, fillPage } = makeLayouterOffice()
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      trashSlidesDraftDocument: trashDraft,
      slidesLayoutOffice: office,
      slidesEditor: { active: true },
      searchMaterials: () => [],
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '先看一页效果', draftDocumentId: 'doc-draft-1', previewPages: 1 } as never,
      undefined,
      vi.fn(),
    )
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({ status: 'completed', previewPages: 1, fileEntryId: 'file-1' })
    expect(String(payload.message)).toContain('不含封面')
    // 编排只收到 1 个内容页（业绩），封面不进编排。
    const plannerInput = orchestrator.dispatch.mock.calls[0]![0] as { input: Record<string, unknown> }
    expect(plannerInput.input.draftPages).toHaveLength(1)
    expect((plannerInput.input.draftPages as Array<{ title: string }>)[0]!.title).toBe('业绩')
    // 只落 1 页，且是首个内容页（业绩），封面不占试看名额；
    // planner 把单页编成 cover 时（夹具 index 0 即 cover），落页前改回 content 角色。
    const layouterInputs = orchestrator.dispatch.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((dispatch) => dispatch.agentId === 'slides-layouter')
      .map((dispatch) => dispatch.input as Record<string, unknown>)
    expect(layouterInputs).toHaveLength(1)
    expect((layouterInputs[0]!.content as { message?: string }).message).toBe('业绩')
    expect(layouterInputs[0]!.role).not.toBe('cover')
    expect(fillPage).toHaveBeenCalledTimes(1)
    // 试看不回收草稿。
    expect(trashDraft).not.toHaveBeenCalled()
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('regenerateDeck：没有可复用的生成记录时返回 failed 并指引重新生成', async () => {
    const orchestrator = orchestratorByAgent({})
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot,
      slidesLayoutOffice: makeLayouterOffice().office,
      slidesEditor: { active: true },
      searchMaterials: () => [],
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', draftDocumentId: 'doc-draft-1', regenerateDeck: true } as never,
      undefined,
      vi.fn(),
    )
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({ status: 'failed', errorCode: 'slides_regenerate_unavailable' })
    expect(orchestrator.dispatch).not.toHaveBeenCalled()
  })

  it('generate：整册拆批编排——按批派发、按全册序合并（长 deck 不再整册一次成稿）', async () => {
    const tenPageMarkdown = Array.from({ length: 10 }, (_, index) => `## 第${index + 1}页\n- 要点${index + 1}`).join('\n\n') + '\n'
    const draftSnapshot10 = {
      ...draftSnapshot,
      document: { ...draftSnapshot.document, id: 'doc-draft-10', title: '十页汇报' },
      markdown: tenPageMarkdown,
    }
    const globalPages = withSemanticContent(tenPageMarkdown, 'doc-draft-10')
    const plannerInputs: Array<Record<string, unknown>> = []
    const orchestrator = orchestratorByAgent({
      'slides-planner': (input) => {
        const dispatchInput = input as { input: Record<string, unknown> }
        plannerInputs.push(dispatchInput.input)
        const sources = dispatchInput.input.sources as Array<{ pageId: string }>
        const pageIds = new Set(sources.map((source) => source.pageId))
        const pages = globalPages.filter((page) => pageIds.has((page.content as { id: string }).id))
        return {
          result: {
            text: '',
            structuredOutput: {
              phase: 'arrange',
              title: '十页汇报',
              narrative: `本批 ${pages.length} 页`,
              pages,
              warnings: [],
              summary: '',
            },
          },
        }
      },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot10,
      slidesLayoutOffice: makeLayouterOffice().office,
      slidesEditor: { active: true },
      searchMaterials: () => [{
        ref: 'everroom-material://batch-photo',
        kind: 'photo' as const,
        desc: '批次素材',
        meta: '照片 1920×1080',
        rank: 4,
      }],
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const onUpdate = vi.fn()
    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '做一份十页汇报', draftDocumentId: 'doc-draft-10' } as never,
      undefined,
      onUpdate,
    )
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('completed')

    // 10 页 → 2 批（各 5 页）；每批只拿本批页与来源，且不带 prewarmToken。
    expect(plannerInputs).toHaveLength(2)
    expect(plannerInputs.map((input) => (input.draftPages as unknown[]).length)).toEqual([5, 5])
    expect(plannerInputs.map((input) => (input.arrangeBatch as Record<string, unknown>).index)).toEqual([0, 1])
    expect(plannerInputs.map((input) => (input.arrangeBatch as Record<string, unknown>).startPageIndex)).toEqual([0, 5])
    expect(plannerInputs.every((input) => input.prewarmToken === undefined)).toBe(true)
    expect(plannerInputs.map((input) => (input.arrangeBatch as Record<string, unknown>).deckTitle)).toEqual(['十页汇报', '十页汇报'])
    // 素材命中按批重排为批内 0 基页序（min 到本批页数为止）。
    expect((plannerInputs[0]!.materialHits as Array<{ pageIndex: number }>).map((hit) => hit.pageIndex))
      .toEqual([0, 1, 2, 3, 4])

    // 合并后 plan_ready 仍是全册 10 页、页序正确。
    const planReady = onUpdate.mock.calls
      .map((call) => (call[0] as { details: Record<string, unknown> }).details)
      .find((details) => details.stage === 'plan_ready')!
    expect(planReady.totalPages).toBe(10)
    expect((planReady.pages as Array<{ title: string }>).map((page) => page.title))
      .toEqual(Array.from({ length: 10 }, (_, index) => `第${index + 1}页`))
  })

  it('generate：分批流水线——首批完成即落页，不等后续批编排', async () => {
    const tenPageMarkdown = Array.from({ length: 10 }, (_, index) => `## 第${index + 1}页\n- 要点${index + 1}`).join('\n\n') + '\n'
    const draftSnapshot10 = {
      ...draftSnapshot,
      document: { ...draftSnapshot.document, id: 'doc-draft-10', title: '十页汇报' },
      markdown: tenPageMarkdown,
    }
    const globalPages = withSemanticContent(tenPageMarkdown, 'doc-draft-10')
    const plannerInputs: Array<Record<string, unknown>> = []
    const base = orchestratorByAgent({
      'slides-planner': (input) => {
        const dispatchInput = input as unknown as { input: Record<string, unknown> }
        plannerInputs.push(dispatchInput.input)
        const sources = dispatchInput.input.sources as Array<{ pageId: string }>
        const pageIds = new Set(sources.map((source) => source.pageId))
        const pages = globalPages.filter((page) => pageIds.has((page.content as { id: string }).id))
        return {
          result: {
            text: '',
            structuredOutput: { phase: 'arrange', title: '十页汇报', pages, warnings: [], summary: '' },
          },
        }
      },
    })
    let releaseSecondBatch: () => void = () => {}
    const secondBatchGate = new Promise<void>((resolve) => { releaseSecondBatch = resolve })
    const orchestrator = {
      ...base,
      dispatch: vi.fn(async (input: { agentId: string; input?: Record<string, unknown> }) => {
        const batch = input.input?.arrangeBatch as { index?: number } | undefined
        if (input.agentId === 'slides-planner' && batch?.index === 1) await secondBatchGate
        return base.dispatch(input as never)
      }),
    }
    const office = makeLayouterOffice()
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator as never, {
      resolveDocumentForDraft: () => draftSnapshot10,
      slidesLayoutOffice: office.office,
      slidesEditor: { active: true },
      searchMaterials: () => [{
        ref: 'everroom-material://batch-photo',
        kind: 'photo' as const,
        desc: '批次素材',
        meta: '照片 1920×1080',
        rank: 4,
      }],
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const pending = slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '做一份十页汇报', draftDocumentId: 'doc-draft-10' } as never,
      undefined,
      vi.fn(),
    )
    // 第二批仍在编排：首批 5 页已经派布局并落进 deck（不必等整册编排完）。
    await vi.waitFor(() => expect(office.fillPage.mock.calls.length).toBeGreaterThanOrEqual(5), { timeout: 5000 })
    const landedEarly = office.fillPage.mock.calls.map((call) => (call[0] as { slideIndex: number }).slideIndex)
    expect(landedEarly.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
    expect(plannerInputs.map((input) => (input.arrangeBatch as { index: number }).index)).toEqual([0])

    releaseSecondBatch()
    const result = await pending
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('completed')
    expect(payload.pages).toBe(10)
    const landed = office.fillPage.mock.calls.map((call) => (call[0] as { slideIndex: number }).slideIndex)
    expect(landed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('generate（流式）→ regenerateDeck：重生成凭据在流式收尾写入，重排复用同一文件', async () => {
    const tenPageMarkdown = Array.from({ length: 10 }, (_, index) => `## 第${index + 1}页\n- 要点${index + 1}`).join('\n\n') + '\n'
    const draftSnapshot10 = {
      ...draftSnapshot,
      document: { ...draftSnapshot.document, id: 'doc-draft-10', title: '十页汇报' },
      markdown: tenPageMarkdown,
    }
    const globalPages = withSemanticContent(tenPageMarkdown, 'doc-draft-10')
    const orchestrator = orchestratorByAgent({
      'slides-planner': (input) => {
        const dispatchInput = input as unknown as { input: Record<string, unknown> }
        const sources = dispatchInput.input.sources as Array<{ pageId: string }>
        const pageIds = new Set(sources.map((source) => source.pageId))
        const pages = globalPages.filter((page) => pageIds.has((page.content as { id: string }).id))
        return {
          result: {
            text: '',
            structuredOutput: { phase: 'arrange', title: '十页汇报', pages, warnings: [], summary: '' },
          },
        }
      },
    })
    const { office, generate, fillPage } = makeLayouterOffice()
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot10,
      slidesLayoutOffice: office,
      slidesEditor: { active: true },
      searchMaterials: () => [],
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const first = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '做一份十页汇报', draftDocumentId: 'doc-draft-10' } as never,
      undefined,
      vi.fn(),
    )
    expect(JSON.parse((first as { content: string }).content)).toMatchObject({ status: 'completed', pages: 10 })
    expect(generate).toHaveBeenCalledTimes(1)

    orchestrator.dispatch.mockClear()
    fillPage.mockClear()
    const second = await slidesDraft.execute(
      run as never,
      { task: 'generate', draftDocumentId: 'doc-draft-10', regenerateDeck: true } as never,
      undefined,
      vi.fn(),
    )
    const payload = JSON.parse((second as { content: string }).content)
    expect(payload).toMatchObject({ status: 'completed', fileEntryId: 'file-1' })
    const agents = orchestrator.dispatch.mock.calls.map((call) => (call[0] as Record<string, unknown>).agentId)
    expect(agents).not.toContain('slides-planner')
    expect(agents.filter((agentId) => agentId === 'slides-layouter')).toHaveLength(10)
    // 同一 deck：不新建文件，10 页全部原地重填。
    expect(generate).toHaveBeenCalledTimes(1)
    expect(fillPage).toHaveBeenCalledTimes(10)
    expect(fillPage.mock.calls.every((call) => call[0]!.fileId === 'file-1')).toBe(true)
  })

  it('generate：共享 token 预算停止多页排版，重试保留已耗预算，显式重置后续跑', async () => {
    const base = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: {
        ...planFixture, phase: 'arrange', pages: withSemanticContent(DRAFT_MD_MAIN, 'doc-draft-1'),
      } } },
    })
    const originalDispatch = base.dispatch
    let reportUsage = true
    base.dispatch = vi.fn(async input => {
      const result = await originalDispatch(input)
      input.onUsage?.(result.id, { input: reportUsage ? 40 : 0 })
      return result
    })
    const office = makeLayouterOffice()
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), base, {
      resolveDocumentForDraft: () => draftSnapshot,
      slidesLayoutOffice: office.office,
      slidesEditor: { active: true },
      slidesGenerationBudget: { maxTokens: 60 },
    })
    const tool = tools.find(tool => tool.name === 'slides_draft')!
    const params = { task: 'generate', instruction: '做一份汇报', draftDocumentId: 'doc-draft-1' }
    const first = JSON.parse((await tool.execute(run as never, params as never)).content)
    expect(first).toMatchObject({ status: 'failed', errorCode: 'slides_generation_token_budget_exceeded' })
    const calls = base.dispatch.mock.calls.length
    const retry = JSON.parse((await tool.execute(run as never, params as never)).content)
    expect(retry.errorCode).toBe('slides_generation_token_budget_exceeded')
    expect(base.dispatch).toHaveBeenCalledTimes(calls)
    reportUsage = false
    const reset = JSON.parse((await tool.execute(run as never,
      { ...params, resetGenerationBudget: true } as never)).content)
    expect(reset.status).toBe('completed')
    expect(office.generate).toHaveBeenCalledTimes(1)
  })

  it('generate：分批编排 checkpoint——重启后只补失败批次，不重跑已完成批', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slides-factory-restart-'))
    const databasePath = join(root, 'gateway.sqlite')
    let database = createDatabase(databasePath, resolve('drizzle'))
    try {
    const ninePageMarkdown = Array.from({ length: 9 }, (_, index) => `## 第${index + 1}页\n- 要点${index + 1}`).join('\n\n') + '\n'
    const draftSnapshot9 = {
      ...draftSnapshot,
      document: { ...draftSnapshot.document, id: 'doc-draft-9', title: '九页汇报' },
      markdown: ninePageMarkdown,
    }
    const globalPages = withSemanticContent(ninePageMarkdown, 'doc-draft-9')
    let failFirstBatch = true
    const plannerInputs: Array<Record<string, unknown>> = []
    const orchestrator = orchestratorByAgent({
      'slides-planner': (input) => {
        const dispatchInput = input as { input: Record<string, unknown> }
        plannerInputs.push(dispatchInput.input)
        const batch = dispatchInput.input.arrangeBatch as { index: number }
        if (batch.index === 0 && failFirstBatch) {
          return {
            status: 'timed_out',
            errorCode: 'timeout',
            errorMessage: 'subagent invocation timed out',
            result: null,
          }
        }
        const sources = dispatchInput.input.sources as Array<{ pageId: string }>
        const pageIds = new Set(sources.map((source) => source.pageId))
        const pages = globalPages.filter((page) => pageIds.has((page.content as { id: string }).id))
        return {
          result: {
            text: '',
            structuredOutput: {
              phase: 'arrange',
              title: '九页汇报',
              narrative: `本批 ${pages.length} 页`,
              pages,
              warnings: [],
              summary: '',
            },
          },
        }
      },
    })
    const options = {
      resolveDocumentForDraft: () => draftSnapshot9,
      slidesLayoutOffice: makeLayouterOffice().office,
      slidesEditor: { active: true },
    }
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      ...options, slidesCheckpoints: new SlidesGenerationCheckpointStore(database.db),
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const params = {
      task: 'generate',
      instruction: '做一份九页汇报',
      draftDocumentId: 'doc-draft-9',
    } as never

    const first = await slidesDraft.execute(run as never, params, undefined)
    const firstPayload = JSON.parse((first as { content: string }).content)
    expect(firstPayload.status).toBe('failed')
    expect(firstPayload.errorCode).toBe('slides_arrange_batch_failed')
    expect(firstPayload.message).toContain('重试只补未完成批次')
    // 批 0 两次尝试 + 批 1 一次成功 = 3 次 planner 派发；批 1 已进 checkpoint。
    expect(plannerInputs).toHaveLength(3)

    failFirstBatch = false
    plannerInputs.length = 0
    database.sqlite.close()
    database = createDatabase(databasePath, resolve('drizzle'))
    const resumed = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      ...options, slidesCheckpoints: new SlidesGenerationCheckpointStore(database.db),
    }).find(tool => tool.name === 'slides_draft')!
    const second = await resumed.execute(run as never, params, undefined)
    const secondPayload = JSON.parse((second as { content: string }).content)
    expect(secondPayload.status).toBe('completed')
    // 批 1 命中 checkpoint 不再派发；只补批 0。
    expect(plannerInputs).toHaveLength(1)
    expect((plannerInputs[0]!.arrangeBatch as { index: number }).index).toBe(0)
    } finally {
      database.sqlite.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('generate：整批重试把上一轮的具体失败原因带回 planner（previousErrors）', async () => {
    const tenPageMarkdown = Array.from({ length: 10 }, (_, index) => `## 第${index + 1}页\n- 要点${index + 1}`).join('\n\n') + '\n'
    const draftSnapshot10 = {
      ...draftSnapshot,
      document: { ...draftSnapshot.document, id: 'doc-draft-10', title: '十页汇报' },
      markdown: tenPageMarkdown,
    }
    const globalPages = withSemanticContent(tenPageMarkdown, 'doc-draft-10')
    const plannerInputs: Array<Record<string, unknown>> = []
    let firstAttemptFailed = false
    const orchestrator = orchestratorByAgent({
      'slides-planner': (input) => {
        const dispatchInput = input as { input: Record<string, unknown> }
        const batch = dispatchInput.input.arrangeBatch as { index: number }
        plannerInputs.push(dispatchInput.input)
        // 批 0 第一次派发瞬时失败（可重试），第二次应带上上一轮失败原因。
        if (batch.index === 0 && !firstAttemptFailed) {
          firstAttemptFailed = true
          return { status: 'timed_out', errorCode: 'timeout', errorMessage: 'planner 超时', result: null }
        }
        const sources = dispatchInput.input.sources as Array<{ pageId: string }>
        const pageIds = new Set(sources.map((source) => source.pageId))
        const pages = globalPages.filter((page) => pageIds.has((page.content as { id: string }).id))
        return {
          result: {
            text: '',
            structuredOutput: {
              phase: 'arrange',
              title: '十页汇报',
              narrative: `本批 ${pages.length} 页`,
              pages,
              warnings: [],
              summary: '',
            },
          },
        }
      },
    })
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot10,
      slidesLayoutOffice: makeLayouterOffice().office,
      slidesEditor: { active: true },
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '做一份十页汇报', draftDocumentId: 'doc-draft-10' } as never,
      undefined,
    )
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('completed')
    const batchZeroInputs = plannerInputs.filter((input) => (input.arrangeBatch as { index: number }).index === 0)
    expect(batchZeroInputs).toHaveLength(2)
    expect(batchZeroInputs[0]!.previousErrors).toBeUndefined()
    expect(batchZeroInputs[1]!.previousErrors).toEqual([expect.stringContaining('timed_out')])
  })

  it('generate：layouter 直接拿到语义 content 与角色，不再有第二版文案', async () => {
    const arrangePlan = {
      ...planFixture,
      phase: 'arrange',
      pages: withSemanticContent(DRAFT_MD_MAIN, 'doc-draft-1').map((page) => ({ ...page, density: 'standard' })),
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: arrangePlan } },
      'slides-builder': { result: { text: '', structuredOutput: builderResultFixture } },
    })
    const tools = createSubagentPiTools(
      registryWith(['slides-planner', 'slides-builder', 'slides-editor']),
      orchestrator,
      {
        resolveDocumentForDraft: () => draftSnapshot,
        slidesLayoutOffice: makeLayouterOffice().office,
        slidesEditor: { active: true },
      },
    )
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('completed')

    const dispatches = orchestrator.dispatch.mock.calls.map((call) => call[0] as Record<string, unknown>)
    // 契约一次通过时 editor 一跳都不出现（修复只在契约不过时点名）。
    expect(dispatches.some((dispatch) => dispatch.agentId === 'slides-editor')).toBe(false)

    const layouterInputs = dispatches
      .filter((dispatch) => dispatch.agentId === 'slides-layouter')
      .map((dispatch) => dispatch.input as Record<string, unknown>)
    expect(layouterInputs.map((input) => input.layoutVersion)).toEqual([2, 2, 2])
    // layouter 拿到的是 planner 的语义 content（唯一内容事实源）
    const firstContent = layouterInputs[0]!.content as { message: string }
    expect(firstContent.message).toBe('封面')
    expect((layouterInputs[1]!.content as { message: string }).message).toBe('业绩')
    expect(layouterInputs[1]!.role).toBe('data')
    // 旧压缩链路的字段不再下发
    expect(layouterInputs[0]!.copy).toBeUndefined()
    expect(layouterInputs[0]!.form).toBeUndefined()
    expect(layouterInputs[0]!.points).toBeUndefined()
  })

  it('generate：内容契约不过、指定页修复也拿不到结果时，回报可重试失败且不落兜底整册', async () => {
    // planner 的 content 丢了必留来源（第二页要点缺一条）→ 契约必然不过 → 打回 semantic 修复；
    // 这里让 editor 超时，复原「修不成 → 整册判失败」的路径。
    // 来源 hash 由 harness 的 draftSnapshot markdown 决定，content 必须从它生成。
    const pages = withSemanticContent(draftSnapshot.markdown, 'doc-draft-1')
    // 模拟 planner 丢内容：第二页少绑定最后一条必留来源的 block
    const dropped = pages[1]!.content as { blocks: unknown[]; sourceRefs: string[] }
    dropped.blocks = dropped.blocks.slice(0, 1)
    dropped.sourceRefs = dropped.sourceRefs.slice(0, 1)
    const arrangePlan = {
      phase: 'arrange',
      title: '季度汇报',
      narrative: '业绩回顾到下一步计划',
      pages,
      warnings: [],
      summary: '3 页方案',
    }
    const orchestrator = orchestratorByAgent({
      'slides-planner': { result: { text: '', structuredOutput: arrangePlan } },
      'slides-editor': { status: 'timed_out', errorCode: 'timeout', result: null },
      'slides-builder': { result: { text: '', structuredOutput: builderResultFixture } },
    })
    const tools = createSubagentPiTools(
      registryWith(['slides-planner', 'slides-builder', 'slides-editor']),
      orchestrator,
      { resolveDocumentForDraft: () => draftSnapshot, slidesLayoutOffice: makeLayouterOffice().office, slidesEditor: { active: true } },
    )
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('failed')
    expect(payload.errorCode).toBe('slides_semantic_content_invalid')
    expect(payload.retryable).toBe(true)
    // 具体缺陷进 contentError 供排查
    expect(String(payload.contentError)).toContain('semantic_content_invalid')

    const dispatches = orchestrator.dispatch.mock.calls.map((call) => call[0] as Record<string, unknown>)
    // editor 只在"指定页内容修复"里出现，且只带被打回的页
    const editorDispatches = dispatches.filter((dispatch) => dispatch.agentId === 'slides-editor')
    expect(editorDispatches.length).toBeGreaterThan(0)
    expect(editorDispatches[0]!.task).toBe('单页内容修复')
    const repairInput = editorDispatches[0]!.input as Record<string, unknown>
    expect((repairInput.repairPageIds as string[]).length).toBeGreaterThan(0)
    expect(repairInput.priorStoryboard).toBeTruthy()
    // 一页都不落：契约不过就没有落页
    expect(dispatches.filter((dispatch) => dispatch.agentId === 'slides-layouter').length).toBe(0)
  })

  it('generate：素材缺口页按 imagePrompt 生图回填进 builder 收到的 plan（page_images 进度 + 二次 plan_ready）', async () => {
    const arrangePlan = {
      ...planFixture,
      phase: 'arrange',
      pages: withSemanticContent(DRAFT_MD_MAIN, 'doc-draft-1', [
        (page) => ({ ...page, density: 'sparse', imagePrompt: '深蓝科技感城市天际线，横幅构图，冷色光' }),
        (page) => ({ ...page, role: 'data', density: 'dense', materials: [{ url: 'https://img.example.com/a.png', desc: '已有图' }] }),
        (page) => ({ ...page, density: 'standard', materials: undefined }),
      ]),
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
      slidesEditor: { active: true },
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const onUpdate = vi.fn()
    await slidesDraft.execute(
      run as never,
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
    // 语义链路下无配图页 materials 为空数组（不再有旧的 undefined 约定）。
    expect(layouterInputs[2]!.materials).toEqual([])

    const stages = onUpdate.mock.calls.map((call) => (call[0] as { details: Record<string, unknown> }).details.stage)
    expect(stages).toEqual(['planning', 'plan_ready', 'page_images', 'plan_ready', 'page_applied'])
    const imagesUpdate = onUpdate.mock.calls[2]![0] as { details: Record<string, unknown> }
    expect(imagesUpdate.details).toMatchObject({ stage: 'page_images', totalPages: 1, doneCount: 1 })
  })

  it('generate：生图全部失败流程照常落页，缺口页保持退化', async () => {
    const arrangePlan = {
      ...planFixture,
      phase: 'arrange',
      pages: withSemanticContent(DRAFT_MD_MAIN, 'doc-draft-1', [
        (page) => ({ ...page, density: 'sparse', imagePrompt: '深蓝科技感城市天际线' }),
        (page) => ({ ...page, density: 'dense' }),
        (page) => ({ ...page, density: 'standard' }),
      ]),
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
      slidesEditor: { active: true },
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    expect(orchestrator.dispatch).toHaveBeenCalledTimes(4) // planner + 3 布局（三页草稿）
    const layouterInputs = orchestrator.dispatch.mock.calls
      .filter((call) => (call[0] as Record<string, unknown>).agentId === 'slides-layouter')
      .map((call) => (call[0] as Record<string, unknown>).input as Record<string, unknown>)
    // 生图失败：封面页 materials 为空数组（语义链路的空态），整册照常完成。
    expect(layouterInputs[0]!.materials).toEqual([])
  })

  it('generate：落页部分完成时草稿保留（便于重试），不回收', async () => {
    const arrangePlan = {
      phase: 'arrange',
      title: '季度汇报',
      pages: withSemanticContent(DRAFT_MD_MAIN, 'doc-draft-1'),
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
      slidesEditor: { active: true },
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('partial')
    expect(payload.pages).toBe(2)
    expect(payload.warnings.join('\n')).toContain('第 2 页落页失败')
    expect(trashDraft).not.toHaveBeenCalled()
  })

  it('generate：缺少 draftDocumentId 或草稿解析不到页结构即返回 failed，不发生调度', async () => {
    const orchestrator = orchestratorReturning({})
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => ({ ...draftSnapshot, markdown: '被清空的文档' }),
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    // 无 id 且无可恢复的风格会话：不再在参数校验抛错，走 JSON 失败（网关按最新会话自动恢复的入口）。
    const noId = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成' } as never,
      undefined,
    )
    const noIdPayload = JSON.parse((noId as { content: string }).content)
    expect(noIdPayload.status).toBe('failed')
    expect(noIdPayload.errorCode).toBe('slides_draft_document_required')

    const emptyDraft = await slidesDraft.execute(
      run as never,
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
      run as never,
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
      run as never,
      { task: 'generate', instruction: '做一份季度汇报', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    expect(orchestrator.dispatch).not.toHaveBeenCalled()
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload).toMatchObject({ status: 'failed', errorCode: 'slides_planner_not_registered' })
  })

  it('edit：不经方案阶段直落 slides-builder；fileId 缺省不进 input；未知参数（含历史 roomId）直接拒绝', async () => {
    const orchestrator = orchestratorReturning({})
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator)
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    // 去 Room：roomId 不再是 slides_draft 的合法参数（按 task 隔离的字段表里已删除）。
    await expect(
      slidesDraft.execute(run as never, { task: 'edit', instruction: '字号调大', roomId: 'room-2' } as never, undefined),
    ).rejects.toThrow('slides_draft_parameter_not_allowed:edit:roomId')

    await expect(slidesDraft.execute(
      run as never,
      { task: 'edit', instruction: '字号调大', style: 'boardroom' } as never,
      undefined,
    )).rejects.toThrow('slides_draft_parameter_not_allowed:edit:style')
    expect(orchestrator.dispatch).not.toHaveBeenCalled()

    await slidesDraft.execute(
      run as never,
      { task: 'edit', instruction: '字号调大' } as never,
      undefined,
    )
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1)
    const dispatched = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>
    expect(dispatched).toMatchObject({ agentId: 'slides-builder', source: 'primary_agent' })
    const input = dispatched.input as Record<string, unknown>
    expect(input).toMatchObject({ task: 'edit', instruction: '字号调大' })
    expect(input).not.toHaveProperty('roomId')
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
      run as never,
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
    const directionCall = orchestrator.dispatch.mock.calls.find((call) => call[0].input?.task === 'direction')
    expect(directionCall?.[0].input?.deckContext).toMatchObject({
      pageCount: 3,
      pageTitles: ['封面', '业绩', '结尾'],
      dataPageCount: 1,
      imagePageCount: 0,
      samplePage: { title: '业绩', points: [], data: 'bar | categories: Q1 | 营收: 1' },
    })
    expect(directionCall?.[0].input?.themeSummary).toBe('做一份商务科技风的汇报')
  })

  it('style：direction 失败的三个兜底均采用内容页、浅底默认值与同一内容结构', async () => {
    const { deps, orchestrator, generateImages } = await setupStyleDeps()
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, { slidesStyle: deps })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    await slidesDraft.execute(
      run as never,
      { task: 'style', instruction: 'AI 创业项目融资 BP', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const generated = generateImages.mock.calls[0]?.[0].candidates
    expect(generated).toHaveLength(3)
    for (const candidate of generated) {
      expect(candidate.prompt).toContain('完整内容页样张')
      expect(candidate.prompt).toMatch(/白色页底|近白页底/)
      expect(candidate.prompt).toContain('共同内容结构：标题主题 "业绩"')
      expect(candidate.prompt).not.toMatch(/深炭黑|亮青|琥珀|赭棕/)
    }
  })

  it('style：兜底保留明确深色要求、参考配色及按时间排序的修改', async () => {
    const { deps, orchestrator, generateImages } = await setupStyleDeps()
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, { slidesStyle: deps })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const referenceStyle = { palette: { background: '#111111', primary: '#008877' }, darkCover: true }
    const first = await slidesDraft.execute(
      run as never,
      { task: 'style', instruction: '深色商务风，不要蓝色', draftDocumentId: 'doc-draft-1', referenceStyle } as never,
      undefined, undefined,
    )
    await slidesDraft.execute(
      run as never,
      { task: 'style', instruction: '允许少量蓝色，其他保持', regenerate: true, referenceStyle } as never,
      undefined, undefined,
    )
    for (const candidate of generateImages.mock.calls[1]?.[0].candidates) {
      expect(candidate.prompt).toContain('深色商务风，不要蓝色')
      expect(candidate.prompt).toContain('允许少量蓝色，其他保持')
      expect(candidate.prompt).toContain('最新明确反馈 > 仍有效的用户要求 > 参考 > 默认方案')
      expect(candidate.prompt).toContain('#008877')
      expect(candidate.prompt).toContain('仅在没有明确要求时采用默认方案')
    }
    const { styleSessionId } = JSON.parse(first.content as string) as { styleSessionId: string }
    await slidesDraft.execute(
      run as never,
      { task: 'style_select', styleSessionId, candidateIndex: 1, referenceStyle } as never,
      undefined, undefined,
    )
    const settleCall = orchestrator.dispatch.mock.calls.find((call) => call[0].input?.task === 'settle')
    expect(settleCall?.[0].input?.feedback).toEqual(['允许少量蓝色，其他保持'])
    expect(settleCall?.[0].input?.deckContext?.samplePage.title).toBe('业绩')
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
      run as never,
      { task: 'style', instruction: '做一份商务科技风的汇报', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )

    const payload = JSON.parse(result.content as string) as { candidates: number; warnings?: string[] }
    expect(payload.candidates).toBe(3)
    expect(payload.warnings).toEqual(['风格提示词由默认模板生成'])
    const genInput = generateImages.mock.calls[0]?.[0] as { candidates: Array<{ label: string; prompt: string }> }
    expect(genInput.candidates).toHaveLength(3)
    // 第三条由兜底种子补足（按序取第一个）。
    expect(genInput.candidates[2]?.label).toBe('清晰数据')
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
      run as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const firstPayload = JSON.parse(first.content as string) as { styleSessionId: string }
    expect(generateImages).toHaveBeenCalledTimes(1)

    // 重入不带 regenerate：不生图、轮次不变，只重新广播候选。
    const reShow = await slidesDraft.execute(
      run as never,
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
      run as never,
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
      run as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const firstSessionId = (JSON.parse(first.content as string) as { styleSessionId: string }).styleSessionId

    // 同 Room 的新草稿：不得把旧候选重新亮出来，须按新草稿新建会话并重新生成。
    const second = await slidesDraft.execute(
      run as never,
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
      run as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const { styleSessionId } = JSON.parse(style.content as string) as { styleSessionId: string }

    const badUpdate = vi.fn()
    const bad = await slidesDraft.execute(
      run as never,
      { task: 'style_select', styleSessionId, candidateIndex: 9 } as never,
      undefined, badUpdate,
    )
    expect((JSON.parse(bad.content as string) as { status: string }).status).toBe('failed')
    // 统一失败载荷：失败也广播 stage:'failed'（含 errorCode/retryable/updatedAt），卡不再消失。
    const failedPayload = badUpdate.mock.calls.at(-1)?.[0] as { details: Record<string, unknown> }
    expect(failedPayload.details).toMatchObject({
      stage: 'failed',
      errorCode: 'slides_style_candidate_invalid',
      retryable: false,
    })
    expect(typeof failedPayload.details.updatedAt).toBe('number')

    const onUpdate = vi.fn()
    const selected = await slidesDraft.execute(
      run as never,
      { task: 'style_select', styleSessionId, candidateIndex: 2 } as never,
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

  it('style：保留候选重复构图，仅在构图缺失时补为网格，并随候选落库', async () => {
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
      run as never,
      { task: 'style', instruction: '做一份商务科技风的汇报', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const payload = JSON.parse(result.content as string) as { styleSessionId: string }

    const genInput = generateImages.mock.calls[0]?.[0] as { candidates: Array<{ composition: string }> }
    const compositions = genInput.candidates.map((candidate) => candidate.composition)
    expect(compositions).toEqual(['poster', 'poster', 'swiss'])
    const session = deps.sessions.byId(payload.styleSessionId)
    expect(session?.overviewImages.length).toBe(3)
    expect(session?.overviewImages.every((image) => typeof image.composition === 'string')).toBe(true)
    expect(session?.overviewImages.map((image) => image.composition)).toEqual(['poster', 'poster', 'swiss'])
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
      run as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const { styleSessionId } = JSON.parse(style.content as string) as { styleSessionId: string }
    const selected = await slidesDraft.execute(
      run as never,
      { task: 'style_select', styleSessionId, candidateIndex: 2 } as never,
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
      pages: withSemanticContent('## 封面\n- 季度汇报\n\n## 业绩\n数据：bar | categories: Q1, Q2 | 营收: 1, 2\n', 'doc-draft-1', [
        (page) => ({ ...page, density: 'sparse' }),
        (page) => ({ ...page, role: 'data', density: 'dense' }),
      ]),
      warnings: [], summary: '',
    }
    const buildResult = { status: 'completed', fileEntryId: 'file-1', fileName: '季度汇报.pptx', pages: 2, outline: ['封面', '业绩'], warnings: [], summary: 'ok' }
    const orchestratorTwo = {
      dispatch: vi.fn(async (input: { agentId: string; input?: { task?: string; phase?: string }; onInvocationId?: (id: string) => void }) => {
        const invocationId = input.agentId === 'slides-planner' ? 'invocation-plan' : 'invocation-build'
        if (input.agentId === 'slides-editor') {
          const editorInput = (input as { input?: { draftPages?: Array<{ title?: string; points?: string[] }>; deckStyle?: { composition?: string } } }).input
          const storyboard = storyboardForDraftPages(editorInput)
          return {
            id: 'invocation-editor',
            agentDefinitionId: 'slides-editor',
            agentRevisionId: 'revision-1',
            source: 'primary_agent',
            parentSessionId: 'session-1',
            parentRunId: 'run-1',
            task: '演示文稿压缩编排',
            input: null,
            status: 'completed',
            result: { text: '', structuredOutput: storyboard },
            errorCode: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }
        }
        if (input.agentId === 'slides-editor') {
          const editorInput = (input as { input?: { draftPages?: Array<{ title?: string; points?: string[]; data?: string }>; deckStyle?: { composition?: string } } }).input
          return {
            id: 'invocation-editor', agentDefinitionId: 'slides-editor', agentRevisionId: 'r1', source: 'primary_agent',
            parentSessionId: 'session-1', parentRunId: 'run-1', task: '演示文稿压缩编排', input: null, status: 'completed',
            result: { text: '', structuredOutput: storyboardForDraftPages(editorInput) },
            errorCode: null, errorMessage: null, createdAt: '', startedAt: '', completedAt: '',
          }
        }
        if (input.agentId === 'slides-layouter') {
          const layouterInput = (input as { input?: { pageIndex?: number; layoutVersion?: number; content?: { blocks?: Array<{ type?: string; text?: string }>; role?: string } } }).input
          const structured = layouterInput?.layoutVersion === 2
            ? layouterResultFor(layouterInput.pageIndex ?? 0, layouterInput?.content)
            : { status: 'done', tree: layouterTreeFor(layouterInput?.pageIndex ?? 0) }
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
            result: { text: '', structuredOutput: structured as Record<string, unknown> },
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
      slidesEditor: { active: true },
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
      run as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const { styleSessionId } = JSON.parse(style.content as string) as { styleSessionId: string }
    const early = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', styleSessionId } as never,
      undefined, undefined,
    )
    expect((JSON.parse(early.content as string) as { errorCode: string }).errorCode).toBe('slides_style_session_invalid')

    // 走到 card_ready → generate 注入 styleParams 给 builder。
    await slidesDraft.execute(
      run as never,
      { task: 'style_select', styleSessionId, candidateIndex: 1 } as never,
      undefined, undefined,
    )
    const generated = await slidesDraft.execute(
      run as never,
      { task: 'generate', draftDocumentId: 'doc-draft-1' } as never,
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
    // 内容侧 planner 也拿到最小 design brief（构图/明暗/母题/主色系），不再只看散文。
    const plannerCalls = (orchestratorTwo.dispatch as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => (call[0] as { agentId: string }).agentId === 'slides-planner')
    expect(plannerCalls.length).toBeGreaterThan(0)
    expect((plannerCalls[0]![0] as { input?: { instruction?: string } }).input?.instruction).toBe('商务科技风')
    const plannerInput = (plannerCalls[plannerCalls.length - 1]![0] as { input?: { deckStyle?: Record<string, unknown> } }).input
    expect(plannerInput?.deckStyle).toMatchObject({ composition: expect.any(String), darkCover: expect.any(Boolean), motif: expect.any(String) })
    expect(deps.sessions.byId(styleSessionId)?.stage).toBe('confirmed')
  })

  it('generate：相邻页布局树同构 → 网关自动重排一次并告警', async () => {
    const { deps } = await setupStyleDeps()
    const arrangePlan = {
      phase: 'arrange', title: '季度汇报', narrative: 'n',
      pages: withSemanticContent('## 封面\n- 季度汇报\n\n## 业绩\n数据：bar | categories: Q1, Q2 | 营收: 1, 2\n', 'doc-draft-1', [
        (page) => ({ ...page, density: 'sparse' }),
        (page) => ({ ...page, role: 'data', density: 'dense' }),
      ]),
      warnings: [], summary: '',
    }
    // 语义链路：树必须承载本页 block 文案（载荷校验），同构树用同一排法、
    // 重排版换构图家族但保留全部文案。
    const payloadTree = (content: { blocks?: Array<{ text?: string }> } | undefined, composition: string) => ({
      version: 2, role: 'content', composition,
      nodes: (content?.blocks ?? []).map((block, index) => ({
        type: 'text', token: index === 0 ? 'h1' : 'body', text: block.text ?? '',
        slot: { col: [1, 8], row: [index + 1, index + 2] },
      })),
    })
    const sameTreeFor = (content: { blocks?: Array<{ text?: string }> } | undefined) => payloadTree(content, 'swiss')
    const differentTreeFor = (content: { blocks?: Array<{ text?: string }> } | undefined) => payloadTree(content, 'editorial')
    const orchestratorSameTree = {
      dispatch: vi.fn(async (input: {
        agentId: string
        input?: {
          neighborSignatures?: string[]
          draftPages?: Array<{ title?: string; points?: string[]; data?: string }>
          deckStyle?: { composition?: string }
        }
      }) => {
        if (input.agentId === 'slides-planner') {
          return {
            id: 'invocation-plan', agentDefinitionId: 'slides-planner', agentRevisionId: 'r1', source: 'primary_agent',
            parentSessionId: 'session-1', parentRunId: 'run-1', task: 't', input: null, status: 'completed',
            result: { text: '', structuredOutput: arrangePlan }, errorCode: null, errorMessage: null,
            createdAt: '', startedAt: '', completedAt: '',
          }
        }
        if (input.agentId === 'slides-editor') {
          return {
            id: 'invocation-editor', agentDefinitionId: 'slides-editor', agentRevisionId: 'r1', source: 'primary_agent',
            parentSessionId: 'session-1', parentRunId: 'run-1', task: '演示文稿压缩编排', input: null, status: 'completed',
            result: { text: '', structuredOutput: storyboardForDraftPages(input.input) },
            errorCode: null, errorMessage: null, createdAt: '', startedAt: '', completedAt: '',
          }
        }
        const isReroll = Array.isArray(input.input?.neighborSignatures)
        const pageContent = (input.input as { content?: { blocks?: Array<{ text?: string }> } } | undefined)?.content
        const tree = isReroll ? differentTreeFor(pageContent) : sameTreeFor(pageContent)
        return {
          id: 'invocation-layout', agentDefinitionId: 'slides-layouter', agentRevisionId: 'r1', source: 'primary_agent',
          parentSessionId: 'session-1', parentRunId: 'run-1', task: 't', input: null, status: 'completed',
          result: { text: '', structuredOutput: { status: 'done', tree, designIntent: '同构重排', bindings: (pageContent?.blocks ?? []).map((block, index) => ({ blockId: (pageContent!.blocks![index] as { id?: string }).id ?? `block-${index}`, paths: [`nodes/${index}`] })) } },
          errorCode: null, errorMessage: null, createdAt: '', startedAt: '', completedAt: '',
        }
      }),
    } as unknown as SubagentOrchestrator
    const office = makeLayouterOffice()
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestratorSameTree, {
      slidesStyle: deps,
      slidesLayoutOffice: office.office,
      slidesEditor: { active: true },
      resolveDocumentForDraft: () => ({
        document: { id: 'doc-draft-1', roomId: 'room-1', title: '季度汇报', version: 1 },
        blocks: [],
        markdown: '## 封面\n- 季度汇报\n\n## 业绩\n数据：bar | categories: Q1, Q2 | 营收: 1, 2\n',
      }),
      trashSlidesDraftDocument: async () => undefined,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    const style = await slidesDraft.execute(
      run as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const { styleSessionId } = JSON.parse(style.content as string) as { styleSessionId: string }
    await slidesDraft.execute(
      run as never,
      { task: 'style_select', styleSessionId, candidateIndex: 1 } as never,
      undefined, undefined,
    )
    const generated = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', styleSessionId } as never,
      undefined, undefined,
    )
    const payload = JSON.parse(generated.content as string) as { status: string; warnings: string[] }
    expect(payload.status).toBe('completed')
    // 语义链路：结构多样性由 layouter 负责，网关不再做相邻同构审计/重排——
    // 即使相邻页树结构一致也照常落页，不追加调度。
    expect(payload.warnings.join('\n')).not.toContain('结构雷同')
    const rerollCall = (orchestratorSameTree as unknown as { dispatch: ReturnType<typeof vi.fn> }).dispatch.mock.calls
      .find((call) => Array.isArray((call[0] as { input?: { neighborSignatures?: string[] } }).input?.neighborSignatures))
    expect(rerollCall).toBeUndefined()
    const appliedIndexes = office.fillPage.mock.calls.map((call) => (call[0] as { slideIndex: number }).slideIndex)
    expect(appliedIndexes.filter((index) => index === 1).length).toBe(1)
  })
  it('generate：run 无 roomId 时凭 styleSessionId 照常续跑（单工作区，不依赖 Room 绑定）', async () => {
    const { deps } = await setupStyleDeps()
    const planFixture = {
      phase: 'arrange', title: '季度汇报', narrative: 'n',
      pages: withSemanticContent('## 封面\n- 季度汇报\n\n## 业绩\n数据：bar | categories: Q1, Q2 | 营收: 1, 2\n', 'doc-draft-1', [
        (page) => ({ ...page, density: 'sparse' }),
        (page) => ({ ...page, role: 'data', density: 'dense' }),
      ]),
      warnings: [], summary: '',
    }
    const buildResult = { status: 'completed', fileEntryId: 'file-1', fileName: '季度汇报.pptx', pages: 2, outline: ['封面', '业绩'], warnings: [], summary: 'ok' }
    const orchestratorTwo = {
      dispatch: vi.fn(async (input: { agentId: string; input?: { task?: string; phase?: string }; onInvocationId?: (id: string) => void }) => {
        const invocationId = input.agentId === 'slides-planner' ? 'invocation-plan' : 'invocation-build'
        if (input.agentId === 'slides-editor') {
          const editorInput = (input as { input?: { draftPages?: Array<{ title?: string; points?: string[] }>; deckStyle?: { composition?: string } } }).input
          const storyboard = storyboardForDraftPages(editorInput)
          return {
            id: 'invocation-editor',
            agentDefinitionId: 'slides-editor',
            agentRevisionId: 'revision-1',
            source: 'primary_agent',
            parentSessionId: 'session-1',
            parentRunId: 'run-1',
            task: '演示文稿压缩编排',
            input: null,
            status: 'completed',
            result: { text: '', structuredOutput: storyboard },
            errorCode: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }
        }
        if (input.agentId === 'slides-editor') {
          const editorInput = (input as { input?: { draftPages?: Array<{ title?: string; points?: string[]; data?: string }>; deckStyle?: { composition?: string } } }).input
          return {
            id: 'invocation-editor', agentDefinitionId: 'slides-editor', agentRevisionId: 'r1', source: 'primary_agent',
            parentSessionId: 'session-1', parentRunId: 'run-1', task: '演示文稿压缩编排', input: null, status: 'completed',
            result: { text: '', structuredOutput: storyboardForDraftPages(editorInput) },
            errorCode: null, errorMessage: null, createdAt: '', startedAt: '', completedAt: '',
          }
        }
        if (input.agentId === 'slides-layouter') {
          const layouterInput = (input as { input?: { pageIndex?: number; layoutVersion?: number; content?: { blocks?: Array<{ type?: string; text?: string }>; role?: string } } }).input
          const structured = layouterInput?.layoutVersion === 2
            ? layouterResultFor(layouterInput.pageIndex ?? 0, layouterInput?.content)
            : { status: 'done', tree: layouterTreeFor(layouterInput?.pageIndex ?? 0) }
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
            result: { text: '', structuredOutput: structured as Record<string, unknown> },
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
      slidesEditor: { active: true },
      resolveDocumentForDraft: () => ({
        document: { id: 'doc-draft-1', roomId: 'room-1', title: '季度汇报', version: 1 },
        blocks: [],
        markdown: '## 封面\n- 季度汇报\n\n## 业绩\n数据：bar | categories: Q1, Q2 | 营收: 1, 2\n',
      }),
      trashSlidesDraftDocument: async () => undefined,
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    const style = await slidesDraft.execute(
      run as never,
      { task: 'style', instruction: '商务科技风', draftDocumentId: 'doc-draft-1' } as never,
      undefined, undefined,
    )
    const { styleSessionId } = JSON.parse(style.content as string) as { styleSessionId: string }
    await slidesDraft.execute(
      run as never,
      { task: 'style_select', styleSessionId, candidateIndex: 1 } as never,
      undefined, undefined,
    )

    // run 无 roomId、无 activeDocument：去 Room 后 slides_draft 不再要求 Room 绑定，
    // 也不存在「反查 Room」这一步——风格会话凭 styleSessionId / draftDocumentId 寻址，
    // 建册直接走工作区（OfficeGenerateInput.roomId 必填位写 null）。
    const generated = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', styleSessionId } as never,
      undefined, undefined,
    )
    expect((JSON.parse(generated.content as string) as { status: string }).status).toBe('completed')
    expect(office.generate.mock.calls[0]![0]).toMatchObject({ roomId: null })
  })
})

describe('createSubagentPiTools slides_draft 配图交互', () => {
  const arrangePlanWithGaps = {
    phase: 'arrange',
    title: '季度汇报',
    narrative: '业绩回顾',
    pages: withSemanticContent('## 封面\n- 季度汇报\n\n## 业绩\n数据：Q1: 1.2 亿\n\n## 计划\n- 三线扩张\n', 'doc-draft-1', [
      (page) => ({ ...page, density: 'sparse', imagePrompt: '深蓝科技感城市天际线，横幅构图，冷色光' }),
      (page) => ({ ...page, role: 'data', density: 'dense' }),
      (page) => ({ ...page, density: 'standard', imagePrompt: '团队协作白板特写，暖光' }),
    ]),
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
        if (input.agentId === 'slides-editor') {
          const editorInput = (input as { input?: { draftPages?: Array<{ title?: string; points?: string[] }>; deckStyle?: { composition?: string } } }).input
          const storyboard = storyboardForDraftPages(editorInput)
          return {
            id: 'invocation-editor',
            agentDefinitionId: 'slides-editor',
            agentRevisionId: 'revision-1',
            source: 'primary_agent',
            parentSessionId: 'session-1',
            parentRunId: 'run-1',
            task: '演示文稿压缩编排',
            input: null,
            status: 'completed',
            result: { text: '', structuredOutput: storyboard },
            errorCode: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }
        }
        if (input.agentId === 'slides-editor') {
          const editorInput = (input as { input?: { draftPages?: Array<{ title?: string; points?: string[]; data?: string }>; deckStyle?: { composition?: string } } }).input
          return {
            id: 'invocation-editor', agentDefinitionId: 'slides-editor', agentRevisionId: 'r1', source: 'primary_agent',
            parentSessionId: 'session-1', parentRunId: 'run-1', task: '演示文稿压缩编排', input: null, status: 'completed',
            result: { text: '', structuredOutput: storyboardForDraftPages(editorInput) },
            errorCode: null, errorMessage: null, createdAt: '', startedAt: '', completedAt: '',
          }
        }
        if (input.agentId === 'slides-layouter') {
          const layouterInput = (input as { input?: { pageIndex?: number; layoutVersion?: number; content?: { blocks?: Array<{ type?: string; text?: string }>; role?: string } } }).input
          const structured = layouterInput?.layoutVersion === 2
            ? layouterResultFor(layouterInput.pageIndex ?? 0, layouterInput?.content)
            : { status: 'done', tree: layouterTreeFor(layouterInput?.pageIndex ?? 0) }
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
            result: { text: '', structuredOutput: structured as Record<string, unknown> },
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
    options: { outcomes?: Array<{ ok: true; hash: string } | { ok: false; error: Error }>; arrangePlan?: Record<string, unknown> } = {},
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
      'slides-planner': { result: { text: '', structuredOutput: options.arrangePlan ?? arrangePlanWithGaps } },
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
      slidesEditor: { active: true },
    })
    return tools.find((tool) => tool.name === 'slides_draft')!
  }

  it('缺口页停确认卡：fresh generate 返回 page_images_confirm，会话落库，builder 未调度', async () => {
    const setup = await setupPageImages()
    const slidesDraft = buildTools(setup)
    const onUpdate = vi.fn()

    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
      onUpdate,
    )

    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(1) // 只编排未落页
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('page_images_confirm')
    expect(payload.pages).toBe(2)
    const session = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')
    expect(session?.stage).toBe('confirm')
    expect(session?.pages).toHaveLength(2)
    expect(session?.pages[0]).toMatchObject({ pageIndex: 0, title: '封面', contentHash: null })
    const stages = onUpdate.mock.calls.map((call) => (call[0] as { details: Record<string, unknown> }).details.stage)
    expect(stages).toEqual(['planning', 'plan_ready', 'page_images_confirm'])
    const confirmPayload = onUpdate.mock.calls.at(-1)?.[0] as { details: Record<string, unknown> }
    expect(confirmPayload.details).toMatchObject({ stage: 'page_images_confirm', documentId: 'doc-draft-1', totalPages: 2 })
    expect(setup.generateImage).not.toHaveBeenCalled()
  })

  it('试看轮配图只做范围内页：封面与范围外缺口页不进会话不生图', async () => {
    // 编排输入已按试看范围裁剪为 [业绩, 计划]（封面排除），夹具按裁剪后草稿算来源 hash。
    const scopedGapPlan = {
      phase: 'arrange',
      title: '季度汇报',
      narrative: '业绩回顾',
      pages: withSemanticContent('## 业绩\n数据：Q1: 1.2 亿\n\n## 计划\n- 三线扩张\n', 'doc-draft-1', [
        (page) => ({ ...page, role: 'data', density: 'dense' }),
        (page) => ({ ...page, density: 'standard', imagePrompt: '团队协作白板特写，暖光' }),
      ]),
      warnings: [],
      summary: '2 页方案',
    }
    const setup = await setupPageImages({ arrangePlan: scopedGapPlan })
    const slidesDraft = buildTools(setup)

    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '先试两页', draftDocumentId: 'doc-draft-1', previewPages: 2 } as never,
      undefined,
      vi.fn(),
    )

    // 范围 = [业绩, 计划]：缺口页只剩「计划」进会话，封面缺口不进。
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('page_images_confirm')
    expect(payload.pages).toBe(1)
    const session = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')
    expect(session?.pages).toHaveLength(1)
    expect(session?.pages[0]).toMatchObject({ pageIndex: 1, title: '计划' })
    // 会话方案与编排一致（裁剪后的范围页），确认后装配同源。
    expect((session?.plan as { pages: unknown[] }).pages).toHaveLength(2)
    expect(setup.generateImage).not.toHaveBeenCalled()
  })

  it('重入只重展示：无参重调不重排不烧配额', async () => {
    const setup = await setupPageImages()
    const slidesDraft = buildTools(setup)
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(1)

    const again = await slidesDraft.execute(
      run as never,
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
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    const onUpdate = vi.fn()
    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
      onUpdate,
    )

    expect(setup.generateImage).toHaveBeenCalledTimes(2)
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('page_images_review')
    expect(payload.generated).toBe(2)
    const session = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')
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
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
    )

    const onUpdate = vi.fn()
    const result = await slidesDraft.execute(
      run as never,
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
    const session = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')
    expect(session?.pages[1]?.contentHash).toBe('c'.repeat(64))
    expect(session?.generation).toBe(2)
    const reviewPayload = onUpdate.mock.calls.at(-1)?.[0] as { details: Record<string, unknown> }
    expect(reviewPayload.details.generation).toBe(2)
    expect((reviewPayload.details.pages as Array<{ url?: string }>)[1]?.url).toBe(`everroom-material://${'c'.repeat(64)}`)
  })

  it('批量配图：regenerate/reject/restore 数组一次调用内循环处理、逐张广播并合并 message', async () => {
    const setup = await setupPageImages({ outcomes: [
      { ok: true, hash: 'a'.repeat(64) },
      { ok: true, hash: 'b'.repeat(64) },
      { ok: true, hash: 'c'.repeat(64) },
    ] })
    const slidesDraft = buildTools(setup)
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
    )

    const onUpdate = vi.fn()
    const result = await slidesDraft.execute(
      run as never,
      {
        task: 'generate',
        instruction: '批量处置',
        draftDocumentId: 'doc-draft-1',
        regeneratePageImages: [1, 2],
        rejectPageImages: [2],
      } as never,
      undefined,
      onUpdate,
    )

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('page_images_review')
    expect(String(payload.message)).toContain('已打回第 2 张配图')
    expect(String(payload.message)).toContain('已重新生成第 1、2 张配图')
    // 逐张广播 review 快照（打回 + 两次重生成）。
    const reviewBroadcasts = onUpdate.mock.calls
      .map((call) => (call[0] as { details: Record<string, unknown> }).details)
      .filter((details) => details.stage === 'page_images_review')
    expect(reviewBroadcasts.length).toBe(3)
    // 重生成撤销了同批打回：第 2 张最终恢复使用。
    const session = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')
    expect(session?.pages[0]?.contentHash).toBe('c'.repeat(64))
    expect(session?.pages[1]?.rejected).toBe(false)
    expect(session?.pages[1]?.contentHash).toBeTruthy()
  })

  it('decision=accept：builder 收到注入配图的 plan，完成后会话 resolved', async () => {
    const setup = await setupPageImages({ outcomes: [
      { ok: true, hash: 'a'.repeat(64) },
      { ok: true, hash: 'b'.repeat(64) },
    ] })
    const slidesDraft = buildTools(setup)
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
    )

    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '确认落页', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'accept' } as never,
      undefined,
    )

    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(4) // planner + 3 布局（审页代理已砍）
    const layouterInputs = setup.orchestrator.dispatch.mock.calls
      .filter((call) => (call[0] as Record<string, unknown>).agentId === 'slides-layouter')
      .map((call) => (call[0] as Record<string, unknown>).input as Record<string, unknown>)
    expect(layouterInputs[0]!.materials).toEqual([
      { url: `everroom-material://${'a'.repeat(64)}`, desc: expect.stringContaining('AI 生成配图') },
    ])
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('completed')
    expect(setup.deps.pageImageSessions!.byDraftId('doc-draft-1')?.stage).toBe('resolved')
  })

  it('decision=accept 不带 styleSessionId：靠配图会话回查仍注入风格卡（回归：桌面罐头消息不带 styleSessionId）', async () => {
    const setup = await setupPageImages({ outcomes: [
      { ok: true, hash: 'a'.repeat(64) },
    ] })
    // 预置 card_ready 风格会话（绑定同一草稿），初始 generate 带 styleSessionId——与真实流程一致。
    const styleSession = setup.deps.sessions.create({ draftDocumentId: 'doc-draft-1', instruction: '商务科技风' })
    setup.deps.sessions.patch(styleSession.id, {
      overviewImages: [{ contentHash: 'c'.repeat(64), composition: 'poster', generation: 1 }],
      selectedImageHash: 'c'.repeat(64),
      styleParams: { palette: { primary: '#1e3a5f' }, composition: 'poster' } as never,
      stage: 'card_ready',
    })
    const slidesDraft = buildTools(setup)
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1', styleSessionId: styleSession.id } as never,
      undefined,
    )
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
    )

    // 确认落页只带 draftDocumentId（桌面罐头消息形态）——风格卡仍必须注入 builder。
    const result = await slidesDraft.execute(
      run as never,
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
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '跳过', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'skip' } as never,
      undefined,
    )

    expect(setup.generateImage).not.toHaveBeenCalled()
    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(4) // planner + 3 布局（审页代理已砍）
    const layouterInputs = setup.orchestrator.dispatch.mock.calls
      .filter((call) => (call[0] as Record<string, unknown>).agentId === 'slides-layouter')
      .map((call) => (call[0] as Record<string, unknown>).input as Record<string, unknown>)
    expect(layouterInputs[0]!.materials).toEqual([])
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
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
    )

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('failed')
    expect(payload.errorCode).toBe('slides_page_images_generation_failed')
    expect(payload.message).toContain('skip')
    expect(setup.deps.pageImageSessions!.byDraftId('doc-draft-1')?.stage).toBe('confirm')
    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(1)
  })

  it('阶段冲突与会话不存在：返回 failed', async () => {
    const setup = await setupPageImages()
    const slidesDraft = buildTools(setup)

    const noSession = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'accept' } as never,
      undefined,
    )
    expect(JSON.parse((noSession as { content: string }).content)).toMatchObject({
      status: 'failed',
      errorCode: 'slides_page_images_session_invalid',
    })

    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    const conflict = await slidesDraft.execute(
      run as never,
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
    pages: withSemanticContent('## 封面\n- 季度汇报\n\n## 计划\n- 三线扩张\n', 'doc-draft-1', [
      (page) => ({ ...page, density: 'sparse', imagePrompt: '深蓝科技感城市天际线' }),
      (page) => ({ ...page, density: 'standard', imagePrompt: '团队协作白板特写' }),
    ]),
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
        if (input.agentId === 'slides-editor') {
          const editorInput = (input as { input?: { draftPages?: Array<{ title?: string; points?: string[] }>; deckStyle?: { composition?: string } } }).input
          const storyboard = storyboardForDraftPages(editorInput)
          return {
            id: 'invocation-editor',
            agentDefinitionId: 'slides-editor',
            agentRevisionId: 'revision-1',
            source: 'primary_agent',
            parentSessionId: 'session-1',
            parentRunId: 'run-1',
            task: '演示文稿压缩编排',
            input: null,
            status: 'completed',
            result: { text: '', structuredOutput: storyboard },
            errorCode: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }
        }
        if (input.agentId === 'slides-editor') {
          const editorInput = (input as { input?: { draftPages?: Array<{ title?: string; points?: string[]; data?: string }>; deckStyle?: { composition?: string } } }).input
          return {
            id: 'invocation-editor', agentDefinitionId: 'slides-editor', agentRevisionId: 'r1', source: 'primary_agent',
            parentSessionId: 'session-1', parentRunId: 'run-1', task: '演示文稿压缩编排', input: null, status: 'completed',
            result: { text: '', structuredOutput: storyboardForDraftPages(editorInput) },
            errorCode: null, errorMessage: null, createdAt: '', startedAt: '', completedAt: '',
          }
        }
        if (input.agentId === 'slides-layouter') {
          const layouterInput = (input as { input?: { pageIndex?: number; layoutVersion?: number; content?: { blocks?: Array<{ type?: string; text?: string }>; role?: string } } }).input
          const structured = layouterInput?.layoutVersion === 2
            ? layouterResultFor(layouterInput.pageIndex ?? 0, layouterInput?.content)
            : { status: 'done', tree: layouterTreeFor(layouterInput?.pageIndex ?? 0) }
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
            result: { text: '', structuredOutput: structured as Record<string, unknown> },
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
      slidesEditor: { active: true },
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成配图', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'generate' } as never,
      undefined,
    )
    return { orchestrator, generateImage, deps, slidesDraft }
  }


  it('分批流水线 + 配图确认：先落非配图页，确认后在同一 deck 续落配图页', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nxcore-stream-images-'))
    const database = createDatabase(join(dir, 'gateway.sqlite'), resolve('drizzle'))
    const deps: SlidesStyleStageDeps = {
      sessions: new SlidesStyleSessionStore(database.db),
      images: { generateImage: vi.fn() } as unknown as SlidesStyleImageGenerator,
      vlm: null,
      readMaterialBytes: async () => null,
      demoRenderer: { renderPptx: async () => { throw new Error('office_bridge_unavailable') } },
      saveDemoPng: async () => ({ contentHash: 'd'.repeat(64) }),
      pageImageSessions: new SlidesPageImageSessionStore(database.db),
    }
    const markdown = Array.from({ length: 10 }, (_, index) => `## 第${index + 1}页\n- 要点${index + 1}`).join('\n\n') + '\n'
    const globalPages = withSemanticContent(markdown, 'doc-draft-10').map((page, index) =>
      index === 5 ? { ...page, imagePrompt: '深蓝科技感城市天际线，横幅构图，冷色光' } : page)
    const draftSnapshot10 = {
      document: { id: 'doc-draft-10', roomId: 'room-1', title: '十页汇报', version: 1 },
      blocks: [],
      markdown,
    }
    const invocationOf = (
      agentId: string,
      invocationId: string,
      structuredOutput: Record<string, unknown>,
      task: string,
    ): SubagentInvocation => ({
      id: invocationId,
      agentDefinitionId: agentId,
      agentRevisionId: 'r1',
      source: 'primary_agent',
      parentSessionId: 'session-1',
      parentRunId: 'run-1',
      task,
      input: null,
      status: 'completed',
      result: { text: '', structuredOutput },
      errorCode: null,
      errorMessage: null,
      createdAt: '',
      startedAt: '',
      completedAt: '',
    })
    const orchestrator = {
      dispatch: vi.fn(async (input: { agentId: string; input?: Record<string, unknown>; onInvocationId?: (id: string) => void }) => {
        const agentId = input.agentId
        const dispatchInput = input.input ?? {}
        if (agentId === 'slides-planner') {
          input.onInvocationId?.('invocation-plan')
          const sources = dispatchInput.sources as Array<{ pageId: string }>
          const pageIds = new Set(sources.map((source) => source.pageId))
          const pages = globalPages.filter((page) => pageIds.has((page.content as { id: string }).id))
          return invocationOf(agentId, 'invocation-plan', { phase: 'arrange', title: '十页汇报', pages, warnings: [], summary: '' }, '演示文稿编排')
        }
        if (agentId === 'slides-layouter') {
          const pageIndex = typeof dispatchInput.pageIndex === 'number' ? dispatchInput.pageIndex : 0
          const invocationId = `invocation-layout-${String(pageIndex)}`
          input.onInvocationId?.(invocationId)
          const content = dispatchInput.content as { blocks?: Array<{ type?: string; text?: string }> } | undefined
          return invocationOf(agentId, invocationId, layouterResultFor(pageIndex, content) as unknown as Record<string, unknown>, '单页布局')
        }
        input.onInvocationId?.('invocation-editor')
        return invocationOf(agentId, 'invocation-editor', storyboardForDraftPages(dispatchInput as never) as unknown as Record<string, unknown>, '演示文稿压缩编排')
      }),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> }
    const office = makeLayouterOffice()
    const tools = createSubagentPiTools(registryWith(['slides-planner', 'slides-builder']), orchestrator, {
      resolveDocumentForDraft: () => draftSnapshot10 as never,
      slidesStyle: deps,
      slidesLayoutOffice: office.office,
      slidesEditor: { active: true },
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!

    const first = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '做十页汇报', draftDocumentId: 'doc-draft-10' } as never,
      undefined,
      vi.fn(),
    )
    const firstPayload = JSON.parse((first as { content: string }).content)
    // 配图页（第 6 页）停在过目卡；其余 9 页已先落进 deck。
    // 逐页追加：等确认的配图页先补一页骨架占位（slideIndex 5 的第一次 fillPage），
    // 让后页 6-9 的页序/页脚不错位；确认后第二轮用真实页原地替换（5 的第二次 fillPage）。
    expect(firstPayload.status).toBe('page_images_confirm')
    const landedFirst = office.fillPage.mock.calls.map((call) => (call[0] as { slideIndex: number }).slideIndex).sort((a, b) => a - b)
    expect(landedFirst).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(office.generate).toHaveBeenCalledTimes(1)
    const session = deps.pageImageSessions!.byDraftId('doc-draft-10')!
    expect(session.stage).toBe('confirm')
    const deck = (session.plan as Record<string, unknown>).__deck as { fileEntryId: string; appliedPages: number[]; totalPages: number }
    expect(deck).toMatchObject({ fileEntryId: 'file-1', totalPages: 10 })
    expect([...deck.appliedPages].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9])

    const second = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '跳过配图', draftDocumentId: 'doc-draft-10', pageImagesDecision: 'skip' } as never,
      undefined,
    )
    const secondPayload = JSON.parse((second as { content: string }).content)
    expect(secondPayload.status).toBe('completed')
    expect(secondPayload.pages).toBe(10)
    // 复用同一个 deck（没有第二次 generate）；只补落配图页（5 被真实页替换，出现第二次）。
    expect(office.generate).toHaveBeenCalledTimes(1)
    const landedAll = office.fillPage.mock.calls.map((call) => (call[0] as { slideIndex: number }).slideIndex).sort((a, b) => a - b)
    expect(landedAll).toEqual([0, 1, 2, 3, 4, 5, 5, 6, 7, 8, 9])
    expect(deps.pageImageSessions!.byDraftId('doc-draft-10')?.stage).toBe('resolved')
    database.sqlite.close()
  })

  it('打回第 1 张：会话标记 + 载荷带 rejected + builder 未调度', async () => {
    const { orchestrator, deps, slidesDraft } = await setupToReview()
    const onUpdate = vi.fn()

    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '打回第一张', draftDocumentId: 'doc-draft-1', rejectPageImage: 1 } as never,
      undefined,
      onUpdate,
    )

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('page_images_review')
    expect(payload.rejected).toBe(1)
    const session = deps.pageImageSessions!.byDraftId('doc-draft-1')
    expect(session?.pages[0]?.rejected).toBe(true)
    expect(session?.pages[1]?.rejected).toBeFalsy()
    const reviewPayload = onUpdate.mock.calls.at(-1)?.[0] as { details: { pages: Array<{ rejected?: boolean }> } }
    expect(reviewPayload.details.pages[0]?.rejected).toBe(true)
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1)
  })

  it('打回后 accept：打回页 materials 被剥、其余页保留', async () => {
    const { orchestrator, generateImage, slidesDraft } = await setupToReview()
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '打回', draftDocumentId: 'doc-draft-1', rejectPageImage: 1 } as never,
      undefined,
    )

    const result = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '确认落页', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'accept' } as never,
      undefined,
    )

    expect(generateImage).toHaveBeenCalledTimes(2)
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(3) // planner + 2 布局（两页草稿）
    const layouterInputs = orchestrator.dispatch.mock.calls
      .filter((call) => (call[0] as Record<string, unknown>).agentId === 'slides-layouter')
      .map((call) => (call[0] as Record<string, unknown>).input as Record<string, unknown>)
    expect(layouterInputs[0]!.materials).toEqual([])
    expect(layouterInputs[1]!.materials).toEqual([
      { url: `everroom-material://${'b'.repeat(64)}`, desc: expect.stringContaining('AI 生成配图') },
    ])
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('completed')
  })

  it('恢复撤销打回；重生成该张也撤销打回', async () => {
    const { generateImage, deps, slidesDraft } = await setupToReview()
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '打回', draftDocumentId: 'doc-draft-1', rejectPageImage: 1 } as never,
      undefined,
    )

    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '恢复', draftDocumentId: 'doc-draft-1', restorePageImage: 1 } as never,
      undefined,
    )
    expect(deps.pageImageSessions!.byDraftId('doc-draft-1')?.pages[0]?.rejected).toBeFalsy()

    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '打回', draftDocumentId: 'doc-draft-1', rejectPageImage: 2 } as never,
      undefined,
    )
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '重做', draftDocumentId: 'doc-draft-1', regeneratePageImage: 2 } as never,
      undefined,
    )
    const session = deps.pageImageSessions!.byDraftId('doc-draft-1')
    expect(session?.pages[1]?.rejected).toBeFalsy()
    expect(session?.pages[1]?.contentHash).toBe('c'.repeat(64))
    expect(generateImage).toHaveBeenCalledTimes(3)
  })

  it('打回越界或阶段不符返回 failed', async () => {
    const { slidesDraft } = await setupToReview()
    const outOfRange = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '打回', draftDocumentId: 'doc-draft-1', rejectPageImage: 5 } as never,
      undefined,
    )
    expect(JSON.parse((outOfRange as { content: string }).content)).toMatchObject({
      status: 'failed',
      errorCode: 'slides_page_image_invalid',
    })

    const noSession = await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '打回', draftDocumentId: 'doc-draft-other', rejectPageImage: 1 } as never,
      undefined,
    )
    // 错草稿 id 回退到最新等待中的配图会话（单工作区一册在配图）：正常打回，不再是 session_invalid。
    expect(JSON.parse((noSession as { content: string }).content)).toMatchObject({
      status: 'page_images_review',
      rejected: 1,
    })
  })
})

describe('createSubagentPiTools slides_draft 配图后台流水', () => {
  const arrangePlanWithGaps = {
    phase: 'arrange',
    title: '季度汇报',
    pages: withSemanticContent('## 封面\n- 季度汇报\n\n## 计划\n- 三线扩张\n', 'doc-draft-1', [
      (page) => ({ ...page, density: 'sparse', imagePrompt: '深蓝科技感城市天际线' }),
      (page) => ({ ...page, density: 'standard', imagePrompt: '团队协作白板特写' }),
    ]),
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
        if (input.agentId === 'slides-editor') {
          const editorInput = (input as { input?: { draftPages?: Array<{ title?: string; points?: string[] }>; deckStyle?: { composition?: string } } }).input
          const storyboard = storyboardForDraftPages(editorInput)
          return {
            id: 'invocation-editor',
            agentDefinitionId: 'slides-editor',
            agentRevisionId: 'revision-1',
            source: 'primary_agent',
            parentSessionId: 'session-1',
            parentRunId: 'run-1',
            task: '演示文稿压缩编排',
            input: null,
            status: 'completed',
            result: { text: '', structuredOutput: storyboard },
            errorCode: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }
        }
        if (input.agentId === 'slides-editor') {
          const editorInput = (input as { input?: { draftPages?: Array<{ title?: string; points?: string[]; data?: string }>; deckStyle?: { composition?: string } } }).input
          return {
            id: 'invocation-editor', agentDefinitionId: 'slides-editor', agentRevisionId: 'r1', source: 'primary_agent',
            parentSessionId: 'session-1', parentRunId: 'run-1', task: '演示文稿压缩编排', input: null, status: 'completed',
            result: { text: '', structuredOutput: storyboardForDraftPages(editorInput) },
            errorCode: null, errorMessage: null, createdAt: '', startedAt: '', completedAt: '',
          }
        }
        if (input.agentId === 'slides-layouter') {
          const layouterInput = (input as { input?: { pageIndex?: number; layoutVersion?: number; content?: { blocks?: Array<{ type?: string; text?: string }>; role?: string } } }).input
          const structured = layouterInput?.layoutVersion === 2
            ? layouterResultFor(layouterInput.pageIndex ?? 0, layouterInput?.content)
            : { status: 'done', tree: layouterTreeFor(layouterInput?.pageIndex ?? 0) }
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
            result: { text: '', structuredOutput: structured as Record<string, unknown> },
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
      slidesEditor: { active: true },
    })
    const slidesDraft = tools.find((tool) => tool.name === 'slides_draft')!
    return { orchestrator, deps, runner, slidesDraft }
  }

  async function reachReviewBackground(setup: Awaited<ReturnType<typeof setupBackground>>) {
    const { slidesDraft } = setup
    await slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )
    return slidesDraft.execute(
      run as never,
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
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
    )

    // 有 runner：过目卡直接亮出（生成中占位），后台并发开跑，无需用户先决策。
    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('page_images_review')
    expect(setup.deps.pageImageSessions!.byDraftId('doc-draft-1')?.stage).toBe('review')
    expect(setup.orchestrator.dispatch).toHaveBeenCalledTimes(1) // 只编排未落页
    // 生图能力可用：编排输入带预热 token（planner 编排中即可入池生图）。
    const plannerCall = setup.orchestrator.dispatch.mock.calls
      .find((call) => (call[0] as { agentId: string }).agentId === 'slides-planner')
    expect((plannerCall![0] as { input?: { prewarmToken?: string } }).input?.prewarmToken).toMatch(/^prewarm:/)
    const sessionId = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')!.id
    await setup.runner.settle(sessionId)
    expect(generateImage).toHaveBeenCalledTimes(2)
    const session = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')
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
    expect(setup.deps.pageImageSessions!.byDraftId('doc-draft-1')?.stage).toBe('review')

    const sessionId = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')!.id
    await setup.runner.settle(sessionId)
    const session = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')
    expect(session?.pages[0]?.contentHash).toBe('a'.repeat(64))
    expect(session?.pages[1]?.contentHash).toBe('b'.repeat(64))
    expect(generateImage).toHaveBeenCalledTimes(2)
  })

  it('生成中 accept：立即按当前状态落页，未完成页标失败无图退化（不再沉默等图）', async () => {
    const gate = deferred<{ contentHash: string }>()
    const generateImage = vi.fn(() => gate.promise)
    const setup = await setupBackground({ generateImage })
    await reachReviewBackground(setup)

    // 后台在途不阻塞：accept 立即返回真完成（旧行为会转 settling 静默等最多 16 分钟）。
    const result = await setup.slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '确认落页', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'accept' } as never,
      undefined,
    )
    // 在途那张的结果晚到：已 abort，不写入会话。
    gate.resolve({ contentHash: 'c'.repeat(64) })

    const payload = JSON.parse((result as { content: string }).content)
    expect(payload.status).toBe('completed')
    // 语义写进返回 message/warnings：未完成页按无图版式落页。
    expect(JSON.stringify(payload)).toContain('未完成')
    const layouterInputs = setup.orchestrator.dispatch.mock.calls
      .filter((call) => (call[0] as { agentId: string }).agentId === 'slides-layouter')
      .map((call) => (call[0] as { input?: Record<string, unknown> }).input)
    expect(layouterInputs.length).toBe(2)
    // 语义链路：无图页 materials 为空数组（不再有 undefined 约定）。
    expect(layouterInputs.every((input) => Array.isArray(input?.materials) && input!.materials!.length === 0)).toBe(true)
    expect(setup.deps.pageImageSessions!.byDraftId('doc-draft-1')?.stage).toBe('resolved')
  })

  it('accept 不等在途：未完成页立即标 failed 且不落图；迟到结果被丢弃', async () => {
    const gate = deferred<{ contentHash: string }>()
    const generateImage = vi.fn(() => gate.promise)
    const setup = await setupBackground({ generateImage })
    await reachReviewBackground(setup)

    const startedAt = Date.now();
    const outcome = await decidePageImages(
      { draftDocumentId: 'doc-draft-1', decision: 'accept' },
      {
        sessions: setup.deps.pageImageSessions!,
        images: { generateImage } as never,
        runner: setup.runner,
      },
    )
    // 立即返回（不再有 settling 等待）。
    expect(Date.now() - startedAt).toBeLessThan(2_000)

    expect(outcome.kind).toBe('build')
    const session = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')
    expect(session?.pages.every((page) => !page.contentHash)).toBe(true)
    expect(session?.pages.every((page) => page.failed === true)).toBe(true)
    const planPages = (outcome as unknown as { plan: { pages: Array<Record<string, unknown>> } }).plan.pages
    expect(planPages.every((page) => page.materials === undefined)).toBe(true)

    // 迟到的后台生成结果：已 abort，写入被丢弃。
    gate.resolve({ contentHash: 'c'.repeat(64) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const after = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')
    expect(after?.pages.every((page) => !page.contentHash)).toBe(true)
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

    const sessionId = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')!.id
    await setup.runner.settle(sessionId)
    const session = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')
    expect(session?.pages[0]?.failed).toBe(true)
    expect(session?.pages[0]?.contentHash).toBeNull()
    expect(session?.pages[1]?.contentHash).toBe('a'.repeat(64))

    const result = await setup.slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '补第一张', draftDocumentId: 'doc-draft-1', regeneratePageImage: 1 } as never,
      undefined,
    )
    expect(JSON.parse((result as { content: string }).content)).toMatchObject({ status: 'page_images_review' })
    expect(setup.deps.pageImageSessions!.byDraftId('doc-draft-1')?.pages[0]?.failed).toBeFalsy()
  })

  it('后台生成中断（中转会话不可用）：未完成页标 failed 并广播 review，不再永远「生成中…」', async () => {
    const generateImage = vi.fn(async () => {
      throw new Error('生图中转会话不可用')
    })
    const setup = await setupBackground({ generateImage })
    const onUpdate = vi.fn()
    const result = await setup.slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '生成', draftDocumentId: 'doc-draft-1' } as never,
      undefined,
      onUpdate,
    )
    expect(JSON.parse((result as { content: string }).content)).toMatchObject({ status: 'page_images_review' })
    const sessionId = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')!.id
    await setup.runner.settle(sessionId)

    const session = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')
    expect(session?.pages.every((page) => page.failed === true)).toBe(true)
    const lastReview = onUpdate.mock.calls
      .map((call) => (call[0] as { details: Record<string, unknown> }).details)
      .filter((details) => details.stage === 'page_images_review')
      .at(-1) as { pages: Array<{ failed?: boolean }>; warnings?: string[] } | undefined
    expect(lastReview?.pages.every((page) => page.failed === true)).toBe(true)
    expect(lastReview?.warnings?.[0]).toContain('未完成')
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
    const sessionId = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')!.id
    await setup.runner.settle(sessionId)

    const result = await setup.slidesDraft.execute(
      run as never,
      { task: 'generate', instruction: '不要配图了', draftDocumentId: 'doc-draft-1', pageImagesDecision: 'skip' } as never,
      undefined,
    )

    expect(JSON.parse((result as { content: string }).content)).toMatchObject({ status: 'completed' })
    const layouterInputs = setup.orchestrator.dispatch.mock.calls
      .filter((call) => (call[0] as { agentId: string }).agentId === 'slides-layouter')
      .map((call) => (call[0] as { input?: Record<string, unknown> }).input)
    // 语义链路：skip 后无图页 materials 为空数组。
    expect(layouterInputs.map((input) => input?.materials).every((materials) => Array.isArray(materials) && materials.length === 0)).toBe(true)
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
      run as never,
      { task: 'generate', instruction: '封面重做', draftDocumentId: 'doc-draft-1', regeneratePageImage: 1, regenerateFeedback: '更亮' } as never,
      undefined,
    )
    expect(JSON.parse((regen as { content: string }).content)).toMatchObject({
      status: 'page_images_review',
      generation: 2,
    })

    slowGate.resolve({ contentHash: 'b'.repeat(64) })
    const sessionId = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')!.id
    await setup.runner.settle(sessionId)
    const session = setup.deps.pageImageSessions!.byDraftId('doc-draft-1')
    // 重生成的新封面哈希（a）未被后台循环覆盖；慢门页拿到自己的哈希（b）。
    expect(session?.pages[0]?.contentHash).toBe('a'.repeat(64))
    expect(session?.pages[1]?.contentHash).toBe('b'.repeat(64))
    expect(session?.generation).toBe(2)
  })
})

describe("createSlidesTreeResultValidator", () => {
  it("合法 v2 页面放行；v1 树与坏树在提交处拒收", async () => {
    const { createSlidesTreeResultValidator } = await import("../src/modules/subagents/slides-agent-tools.js");
    const validator = createSlidesTreeResultValidator();
    const v2Page = {
      version: 2,
      role: "content",
      composition: "swiss",
      nodes: [{ type: "text", token: "h1", text: "标题", slot: { col: [1, 8], row: [1, 2] } }],
    };
    expect(() => validator({}, { status: "done", tree: v2Page })).not.toThrow();
    // v1 树不再被接受：布局只有 v2 一种格式
    expect(() => validator({}, { status: "done", tree: { role: "content", direction: "column", children: [{ type: "divider" }] } }))
      .toThrow(/subagent_result_tree_invalid.*不是 v2 页面/);
    // 2026-10-17 深圳 deck 第 6 页实测形态：提交时根节点只剩 children
    expect(() => validator({}, { status: "done", tree: { children: [{ children: [{ type: "divider" }] }] } })).toThrow(/subagent_result_tree_invalid/);
    // 无树提交（非树类结果）不拦
    expect(() => validator({}, { status: "done" })).not.toThrow();
  });
});
