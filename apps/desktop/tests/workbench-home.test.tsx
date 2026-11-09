// @vitest-environment happy-dom
/**
 * 主页标签六页（最近 / 项目空间 / 所有文件 / Agent / 连接器 / 设置）的渲染测试。
 *
 * 数据全部来自真实桥的形状（mock `window.nxcore`），不引入 testing-library：
 * 与 tests/office-proto-recent-view.test.tsx 同款 `react` act + createRoot 手写渲染。
 *
 * 覆盖：
 * 1. 最近页：真实文件库计数/项目空间数/最近会话/最近文件，且不出现「3 封新邮件」类假数据；
 * 2. 所有文件页：文件名搜索、类型标签、列表/网格切换、点开文件在归属工作空间打开；
 * 3. 文件库失败 → 「文件库暂不可用」（不回退 mock 文件）；
 * 4. 项目空间空态 + 「新建项目空间」走全局事件；
 * 5. 项目空间列表：真实工作数/描述摘要、默认空间不可删、行内重命名写回；
 * 6. Agent 页：布局与原型 everoffice `AgentsPage` 逐行对齐——页头 + 详情头
 *    （头像/名称/简介）+ 三段标签（人格 / 用户画像 / 经验）+ 卡片内容。
 */
import type { AgentSession, AgentWorkspace } from '@nxcore/agent-contract'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileCatalogDto } from '../src/shared/ingest'
import { HomePageHost } from '../src/renderer/src/workbench/home/HomePageHost'
import { HomeSidebar } from '../src/renderer/src/workbench/shell/HomeSidebar'
import { HOME_TAB, HOME_TAB_ID } from '../src/renderer/src/workbench/types'
import { useWorkbenchStore } from '../src/renderer/src/workbench/state/store'

// React 18 的 act() 需要显式声明测试环境，否则每次状态更新都会打 warning。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-10-30T05:00:00.000Z'

/* ───────────────── 数据 fixture ───────────────── */

function makeWorkspace(overrides: Partial<AgentWorkspace> & { id: string; name: string }): AgentWorkspace {
  return {
    description: null,
    goals: [],
    path: null,
    kind: 'custom',
    createdAt: ISO,
    updatedAt: ISO,
    lastOpenedAt: ISO,
    ...overrides,
  }
}

function makeSession(overrides: Partial<AgentSession> & { id: string }): AgentSession {
  return {
    workspaceId: null,
    roomId: null,
    pageLabel: 'Agent',
    runtimeId: 'main',
    title: null,
    status: 'idle',
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }
}

function makeCatalog(overrides: Partial<FileCatalogDto> & { id: string; originalName: string }): FileCatalogDto {
  return {
    displayName: null,
    sharedTitle: overrides.originalName,
    sourceKind: 'manual-upload' as FileCatalogDto['sourceKind'],
    sourceLabel: '本地上传',
    relativePath: null,
    provider: null,
    bytes: 12_800,
    dataType: null,
    agentCategory: null,
    summary: null,
    tags: [],
    processingState: 'ready' as FileCatalogDto['processingState'],
    clusterId: null,
    contentHash: 'a'.repeat(64),
    currentVersionId: null,
    parsed: true,
    updatedAt: ISO,
    workspaceId: null,
    ...overrides,
  }
}

/* ───────────────── 桥 mock ───────────────── */

interface NxcoreOptions {
  catalogs?: FileCatalogDto[]
  total?: number
  filesFail?: boolean
  workspaces?: AgentWorkspace[]
  /** 人格定义返回；personaFail 时整路失败。 */
  persona?: typeof SAMPLE_PERSONA
  personaFail?: boolean
  /** 记忆条目；传 [] 覆盖空态。 */
  memories?: typeof SAMPLE_MEMORIES
  /** 画像接口失败（应与「真的没有画像」区分开）。 */
  profileFail?: boolean
}

const SAMPLE_STATUS = {
  generatedAt: ISO,
  summary: { total: 1, running: 0, idle: 1, error: 0 },
  agents: [{
    agentId: 'main',
    name: '主 Agent',
    description: '负责对话、文档与 Office 产物',
    kind: 'builtin',
    state: 'idle',
    activeRunCount: 0,
    workspace: { id: 'agent://main', isolation: 'dedicated', revisionId: null },
    currentRun: null,
    lastRun: { id: 'run-1', task: '整理周报', pageLabel: 'Agent', status: 'completed', startedAt: ISO, completedAt: ISO },
    updatedAt: ISO,
  }],
}

const SAMPLE_LOCAL_AGENTS = [{
  id: 'codex',
  provider: 'codex',
  displayName: 'Codex CLI',
  executablePath: '/usr/local/bin/codex',
  version: '1.2.3',
  status: 'verified',
  callable: true,
  invocationSupported: true,
  historyAvailable: false,
  historyPaths: [],
  card: {},
  lastSeenAt: ISO,
}]

const SAMPLE_MCP = {
  configPath: '/tmp/mcp.json',
  servers: {
    filesystem: { command: 'npx', args: ['-y', 'mcp-fs'] },
    search: { url: 'https://mcp.test', disabled: true },
  },
}

/** 人格：网关 /v1/agent/definition/:id 的返回形状（内置 Agent bundle）。 */
const SAMPLE_PERSONA = {
  id: 'main',
  name: '主 Agent',
  description: '负责对话、文档与 Office 产物',
  systemPrompt: '你是 NxCore 桌面工作区中的 AI 助手。回答应准确、简洁。',
  skills: ['文档起草', '幻灯片', '表格处理'],
  capabilities: ['office', 'documents'],
}

/** 记忆条目：网关 /v1/memory/entries（hippo-memory）的返回形状。 */
const SAMPLE_MEMORIES = [
  {
    id: 'mem-1',
    content: '用户偏好用简体中文撰写正式文档',
    tags: ['偏好'],
    strength: 0.9,
    halfLifeDays: 365,
    retrievalCount: 2,
    createdAt: ISO,
    score: 0,
    // 长期事实：进画像，不进经验
    layer: 'semantic',
    category: 'fact' as const,
  },
  {
    id: 'mem-2',
    content: '部署前必须先跑数据库迁移',
    tags: ['经验'],
    strength: 0.8,
    halfLifeDays: 730,
    retrievalCount: 1,
    createdAt: ISO,
    score: 0,
    // 经验：整理回合合并成 semantic 后仍然是 lesson，所以类别看 category 而不是 layer
    layer: 'episodic',
    category: 'lesson' as const,
  },
]

/**
 * 画像接口的返回：网关已经分好组，渲染层不做标签判断。
 * 这里按「非经验条目都进偏好组」造数据，够覆盖分组渲染与空态。
 */
function profileFromMemories(memories: typeof SAMPLE_MEMORIES) {
  const items = memories
    .filter((memory) => memory.category !== 'lesson')
    .map((memory) => ({ id: memory.id, content: memory.content }))
  return items.length > 0
    ? { source: 'fallback' as const, groups: [{ title: '偏好', items }] }
    : { source: 'empty' as const, groups: [] }
}

const SAMPLE_USAGE = {
  provider: 'anthropic',
  model: 'claude',
  range: '7d',
  inputTokens: 1200,
  outputTokens: 340,
  cacheHitTokens: 56,
  points: [],
  updatedAt: ISO,
}

function installNxcore(options: NxcoreOptions = {}) {
  const catalogs = options.catalogs ?? []
  const nxcore = {
    files: {
      list: options.filesFail
        ? vi.fn().mockRejectedValue(new Error('gateway unavailable'))
        : vi.fn().mockResolvedValue({ items: catalogs, total: options.total ?? catalogs.length }),
      pickAndImport: vi.fn().mockResolvedValue([]),
      openOriginal: vi.fn().mockResolvedValue({ openedWith: 'office', instanceId: 'x', kind: 'doc', title: 'x' }),
    },
    office: {
      closeInstance: vi.fn().mockResolvedValue(true),
    },
    workspace: {
      list: vi.fn().mockResolvedValue(options.workspaces ?? []),
      create: vi.fn(),
      update: vi.fn(async (id: string, input: Partial<AgentWorkspace>) => ({
        ...makeWorkspace({ id, name: 'x' }),
        ...input,
      })),
      remove: vi.fn().mockResolvedValue(undefined),
      pickDirectory: vi.fn().mockResolvedValue(null),
    },
    agent: {
      getStatus: vi.fn().mockResolvedValue(SAMPLE_STATUS),
      getDefinition: options.personaFail
        ? vi.fn().mockRejectedValue(new Error('gateway unavailable'))
        : vi.fn().mockResolvedValue(options.persona ?? SAMPLE_PERSONA),
      discoverLocalAgents: vi.fn().mockResolvedValue(SAMPLE_LOCAL_AGENTS),
      getUsage: vi.fn().mockResolvedValue(SAMPLE_USAGE),
    },
    memory: {
      listEntries: vi.fn().mockResolvedValue({ items: options.memories ?? SAMPLE_MEMORIES }),
      getProfile: options.profileFail
        ? vi.fn().mockRejectedValue(new Error('gateway unavailable'))
        : vi.fn().mockResolvedValue(profileFromMemories(options.memories ?? SAMPLE_MEMORIES)),
    },
    mcp: {
      listServers: vi.fn().mockResolvedValue(SAMPLE_MCP),
    },
    agentDebug: {
      openWindow: vi.fn().mockResolvedValue(undefined),
    },
  }
  ;(window as unknown as { nxcore: unknown }).nxcore = nxcore
  return nxcore
}

/* ───────────────── 渲染工具 ───────────────── */

let container: HTMLDivElement
let root: Root

/** 推进若干轮宏任务（每轮都在 act 里），让 effects / promise 链跑完。 */
async function flush(rounds = 10, step = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

async function render(page: Parameters<typeof HomePageHost>[0]['page']): Promise<void> {
  await act(async () => {
    root.render(<HomePageHost page={page} />)
  })
  await flush()
}

function text(): string {
  return container.textContent ?? ''
}

function findButtonByText(scope: ParentNode, label: string): HTMLButtonElement {
  const buttons = [...scope.querySelectorAll<HTMLButtonElement>('button')]
  const found = buttons.find((button) => (button.textContent ?? '').includes(label))
  if (!found) throw new Error(`没有找到按钮：${label}`)
  return found
}

/** React 受控 input：必须走原生 value setter + input 事件才能触发 onChange。 */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush(2)
}

async function pressKey(target: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
  await flush(2)
}

function resetStore(patch: {
  workspaces?: AgentWorkspace[]
  sessions?: AgentSession[]
} = {}): void {
  useWorkbenchStore.setState({
    booted: true,
    loading: false,
    error: null,
    workspaces: patch.workspaces ?? [],
    sessions: patch.sessions ?? [],
    tabs: [HOME_TAB],
    activeTabId: HOME_TAB_ID,
    sidebarCollapsed: false,
    pendingSetupWorkspaceId: null,
    settingsSection: null,
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetStore()
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

/* ───────────────── 测试 ───────────────── */

describe('最近页', () => {
  it('渲染真实文件库计数 / 项目空间 / 最近工作 / 最近文件，不出现假数据', async () => {
    installNxcore({
      catalogs: [
        makeCatalog({ id: 'file-1', originalName: '项目周报.docx' }),
      ],
      total: 7,
    })
    const spaces = [
      makeWorkspace({ id: 'default', name: '默认工作区', kind: 'default' }),
      makeWorkspace({ id: 'ws-connector', name: '连接器项目', description: '统一连接器品牌与排期' }),
    ]
    resetStore({
      workspaces: spaces,
      sessions: [
        makeSession({ id: 's-1', workspaceId: 'ws-connector', title: '整理连接器排期', status: 'running' }),
      ],
    })

    await render('recent')

    // 「最近」页头只留问候语，整行副标题已删除。
    expect(container.querySelector('.ui-pagehead-sub')).toBeNull()

    expect(text()).toContain('整理连接器排期')
    expect(text()).toContain('项目周报.docx')
    expect(text()).toContain('连接器项目')
    // 空间行的副行小字（含描述摘要「统一连接器品牌与排期」）已删除。
    expect(text()).not.toContain('统一连接器品牌与排期')

    // 假数据治理：不再出现「今天有 3 封新邮件…」这类无数据支撑的文案。
    expect(text()).not.toContain('封新邮件')
    expect(text()).not.toContain('每日洞察')

    // 「新建」分栏（照原型）：1 个空白空间瓦片 + 4 个文件类型瓦片。
    const newTiles = [...container.querySelectorAll<HTMLButtonElement>('.wb-home-new-tile')]
    expect(newTiles.map((tile) => tile.querySelector('.wb-home-new-name')?.textContent))
      .toEqual(['空白空间', '文字文档', '表格', '演示', 'Markdown'])

    // 「最近」分栏：2 个真实项目空间行 +「打开」；副行小字（时间 · 工作数）已删除。
    const spaceRows = [...container.querySelectorAll<HTMLButtonElement>('.wb-home-space-row')]
    expect(spaceRows.length).toBe(2)
    expect(spaceRows[0].textContent).toContain('打开')
    expect(spaceRows.some((row) => (row.textContent ?? '').includes('项工作'))).toBe(false)

    // 点最近文件行（覆盖整行的透明按钮）→ 在归属工作空间里打开（激活其标签，
    // 文件交给气泡窗；未归类文件落默认空间）。
    const fileRow = [...container.querySelectorAll<HTMLElement>('.wb-home-filerow')]
      .find((row) => (row.textContent ?? '').includes('项目周报.docx'))
    expect(fileRow, '最近文件行应存在').toBeTruthy()
    await act(async () => { fileRow!.querySelector<HTMLButtonElement>('.wb-home-filerow-open')!.click() })
    await flush(2)
    const opened = useWorkbenchStore.getState()
    expect(opened.activeTabId).toBe('ws:default')
    expect(opened.pendingBubbleFile).toMatchObject({ workspaceId: 'default', file: { id: 'real:file-1' } })
  })

  it('「新建」瓦片：空白空间走全局事件，文件瓦片在默认空间打开空白文档', async () => {
    installNxcore()
    resetStore({ workspaces: [makeWorkspace({ id: 'default', name: '默认工作区', kind: 'default' })] })
    await render('recent')

    const onNewSpace = vi.fn()
    window.addEventListener('everroom:workbench-new-space', onNewSpace)
    try {
      await act(async () => { findButtonByText(container, '空白空间').click() })
      expect(onNewSpace).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('everroom:workbench-new-space', onNewSpace)
    }

    await act(async () => { findButtonByText(container, '文字文档').click() })
    await flush(2)
    // 新建文件没有归属 → 默认空间标签激活，文件交接给该标签的气泡窗。
    const opened = useWorkbenchStore.getState()
    expect(opened.activeTabId).toBe('ws:default')
    expect(opened.pendingBubbleFile?.file.id).toMatch(/^f-blank-docx-/)
    expect(opened.pendingBubbleFile?.workspaceId).toBe('default')
  })
})

describe('所有文件页', () => {
  const catalogs = [
    makeCatalog({ id: 'file-doc', originalName: '本周周报.docx', sourceKind: 'manual-upload', sourceLabel: '本地上传' }),
    makeCatalog({ id: 'file-sheet', originalName: '季度汇总.xlsx', sourceKind: 'agent-generated', sourceLabel: 'Agent 生成' }),
    makeCatalog({ id: 'file-pdf', originalName: '外部报告.pdf', sourceKind: 'connector', sourceLabel: '连接器' }),
  ]

  it('类型标签 + 文件名搜索 + 列表/网格切换', async () => {
    installNxcore({ catalogs, total: 3 })
    await render('files')

    const rowsNow = () => [...container.querySelectorAll<HTMLElement>('.wb-home-filerow')]
    expect(rowsNow().length).toBe(3)

    // 表头列（照原型 FileTable）：文件名 / 修改时间（带排序指示）/ 大小。
    const head = container.querySelector('.wb-home-filetbl-head')?.textContent ?? ''
    expect(head).toContain('文件名')
    expect(head).toContain('修改时间')
    expect(head).toContain('大小')

    // 来源筛选标签已按原型去除（原型工具行只有类型标签 + 搜索 + 视图切换）。
    expect(container.querySelector('.wb-home-filetbl-src')).toBeNull()

    // 类型标签（照原型 Seg：胶囊裸标签，不带计数徽标）：
    // 全部 / 文档 / 表格 / 演示 / PDF / Markdown。
    const kindBar = container.querySelector('.wb-home-filetbl-bar .wb-home-ft-seg')
    expect(kindBar, '类型标签栏应存在').toBeTruthy()
    expect([...kindBar!.querySelectorAll('.wb-home-ft-seg-btn')].map((el) => el.textContent))
      .toEqual(['全部', '文档', '表格', '演示', 'PDF', 'Markdown'])

    // 类型筛选：只看表格。
    await act(async () => { findButtonByText(container, '表格').click() })
    await flush(2)
    expect(rowsNow().length).toBe(1)
    expect(rowsNow()[0].textContent).toContain('季度汇总.xlsx')

    // 回到「全部」类型后按文件名搜索。
    await act(async () => { findButtonByText(kindBar!, '全部').click() })
    await flush(2)
    expect(rowsNow().length).toBe(3)
    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索文件"]')
    expect(search).toBeTruthy()
    await typeInto(search!, '周报')
    expect(rowsNow().length).toBe(1)
    expect(rowsNow()[0].textContent).toContain('本周周报.docx')

    // 网格视图（原型 op-ft-views：图标按钮，无文字标签）：同一批数据渲染成文件瓦片。
    const gridToggle = container.querySelector<HTMLButtonElement>('.wb-home-ft-views button[title="网格视图"]')
    expect(gridToggle, '网格视图按钮应存在').toBeTruthy()
    await act(async () => { gridToggle!.click() })
    await flush(2)
    const tiles = container.querySelectorAll('.wb-home-file-tile')
    expect(tiles.length).toBe(1)
    expect(tiles[0].textContent).toContain('本周周报.docx')

    // 点瓦片 → 在归属工作空间里打开（该测试未配空间，落默认空间）。
    await act(async () => { (tiles[0] as HTMLButtonElement).click() })
    await flush(2)
    const opened = useWorkbenchStore.getState()
    expect(opened.activeTabId).toBe('ws:default')
    expect(opened.pendingBubbleFile).toMatchObject({ workspaceId: 'default', file: { id: 'real:file-doc' } })
  })

  it('文件库失败时显示「暂不可用」，不回退 mock 文件', async () => {
    installNxcore({ filesFail: true })
    await render('files')

    expect(text()).toContain('资料暂不可用')
    // 原型 mock 文件名不应出现（无 bridge 时不伪造文件）。
    expect(text()).not.toContain('周报：连接器统一排期')
  })
})

describe('项目空间页', () => {
  it('空态显示真实引导，新建走全局事件（外壳弹窗）', async () => {
    installNxcore()
    const onNewSpace = vi.fn()
    window.addEventListener('everroom:workbench-new-space', onNewSpace)
    try {
      await render('spaces')
      expect(text()).toContain('还没有项目空间')
      await act(async () => { findButtonByText(container, '新建项目空间').click() })
      expect(onNewSpace).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('everroom:workbench-new-space', onNewSpace)
    }
  })

  it('展示真实空间：工作数、描述摘要；默认空间不可删；行内重命名写回 store', async () => {
    installNxcore()
    resetStore({
      workspaces: [
        makeWorkspace({ id: 'default', name: '默认工作区', kind: 'default' }),
        makeWorkspace({ id: 'ws-connector', name: '连接器项目', description: '统一连接器品牌与排期' }),
      ],
      sessions: [makeSession({ id: 's-1', workspaceId: 'ws-connector', title: '整理连接器排期' })],
    })

    await render('spaces')

    expect(text()).toContain('2 个项目空间')
    expect(text()).toContain('1 项工作')
    expect(text()).toContain('统一连接器品牌与排期')
    expect(text()).toContain('默认')

    // 只有自定义空间有删除按钮。
    const deleteLabels = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="删除"]')]
      .map((button) => button.getAttribute('aria-label'))
    expect(deleteLabels).toEqual(['删除 连接器项目'])

    // 行内重命名：点铅笔 → 改值 → 回车 → 调 workspace.update 并写回 store。
    const renameButton = container.querySelector<HTMLButtonElement>('button[aria-label="重命名 连接器项目"]')
    expect(renameButton).toBeTruthy()
    await act(async () => { renameButton!.click() })
    await flush(2)

    const input = container.querySelector<HTMLInputElement>('input[aria-label="空间名称"]')
    expect(input, '行内重命名输入框应出现').toBeTruthy()
    await typeInto(input!, '连接器项目 V2')
    await pressKey(input!, 'Enter')
    await flush(6)

    expect(window.nxcore!.workspace.update).toHaveBeenCalledWith('ws-connector', { name: '连接器项目 V2' })
    expect(useWorkbenchStore.getState().workspaces.map((workspace) => workspace.name)).toContain('连接器项目 V2')
  })
})

describe('Agent 页', () => {
  it('人格段来自网关 Agent 定义：名称、简介、技能标签、提示词摘要', async () => {
    installNxcore()
    await render('agent')

    // Agent 页默认落在「用户画像」，人格是第一个分区。
    const personaTab = Array.from(container.querySelectorAll('.op-seg-btn'))
      .find((el) => el.textContent === '人格')
    await act(async () => { (personaTab as HTMLButtonElement).click() })

    // 页头与 Hero 是原型代码：`op-page-head` 标题「智能体」+ Hero（头像 / 名称 + 状态 pill / 调试）
    expect(container.querySelector('.op-page-head h1')?.textContent).toBe('智能体')
    expect(container.querySelector('.op-agent-hero')).not.toBeNull()
    expect(container.querySelector('.op-agent-avatar svg')).not.toBeNull()
    const name = container.querySelector('.op-agent-hero-name')
    expect(name?.textContent).toContain(SAMPLE_PERSONA.name)
    expect(name?.querySelector('.op-pill.on')?.textContent).toContain('运行中')
    expect(container.querySelector('.op-agent-hero-text p')?.textContent).toBe(SAMPLE_PERSONA.description)
    expect(findButtonByText(container, '调试')).toBeTruthy()

    // 人格卡：原型的 op-info-card + op-chips + op-persona-prompt
    const chips = Array.from(container.querySelectorAll('.op-persona-card .op-chips .op-chip')).map((el) => el.textContent)
    expect(chips).toEqual(SAMPLE_PERSONA.skills)
    expect(text()).toContain('系统提示词（摘要）')
    expect(text()).toContain('你是 NxCore 桌面工作区中的 AI 助手')
  })

  it('三段分区：人格 / 用户画像 / 经验', async () => {
    installNxcore()
    await render('agent')

    const labels = Array.from(container.querySelectorAll('.op-seg .op-seg-btn')).map((el) => el.textContent)
    expect(labels).toEqual(['人格', '用户画像', '经验'])
    // 默认落在画像分区：用户打开 Agent 页最想看的是「它记住了我什么」。
    expect(container.querySelector('.op-seg-btn.active')?.textContent).toBe('用户画像')
  })

  it('用户画像段：原型 op-profile-grid + 每组一张 op-info-card', async () => {
    installNxcore()
    await render('agent')

    // 结构与类名来自原型 ProfileTab：网格 + 每组一张信息卡，分组名是卡片标题
    const groups = container.querySelectorAll('.op-profile-grid > .op-info-card')
    expect(groups).toHaveLength(1)
    expect(container.querySelector('.op-info-title')?.textContent).toBe('偏好')

    // 条目按原型渲染为列表项（不是我们自造的标签）
    const items = Array.from(container.querySelectorAll('.op-info-card ul li'))
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent).toBe(SAMPLE_MEMORIES[0].content)
    // 卡片上方不挂说明文案（原型没有）
    expect(text()).not.toContain('每组一张卡片')
    expect(text()).not.toContain('注入 Agent 的系统上下文')
  })

  it('经验段列出未被归入画像的记忆，并带相对时间', async () => {
    installNxcore()
    await render('agent')

    const insightsTab = Array.from(container.querySelectorAll('.op-seg-btn'))
      .find((el) => el.textContent === '经验')
    await act(async () => { (insightsTab as HTMLButtonElement).click() })

    const items = container.querySelectorAll('.op-info-card li')
    expect(items).toHaveLength(1)
    expect(items[0].textContent).toContain(SAMPLE_MEMORIES[1].content)
    expect(container.querySelector('.wb-home-exp-meta')?.textContent).toBeTruthy()
  })

  it('记忆为空时给出空态而不是假数据', async () => {
    installNxcore({ memories: [] })
    await render('agent')

    const profileTab = Array.from(container.querySelectorAll('.op-seg-btn'))
      .find((el) => el.textContent === '用户画像')
    await act(async () => { (profileTab as HTMLButtonElement).click() })
    expect(text()).toContain('还没有用户画像')

    const insightsTab = Array.from(container.querySelectorAll('.op-seg-btn'))
      .find((el) => el.textContent === '经验')
    await act(async () => { (insightsTab as HTMLButtonElement).click() })
    expect(text()).toContain('还没有积累经验')
  })

  it('画像接口失败时提示读取失败，而不是「还没有沉淀」', async () => {
    installNxcore({ profileFail: true })
    await render('agent')

    const profileTab = Array.from(container.querySelectorAll('.op-seg-btn'))
      .find((el) => el.textContent === '用户画像')
    await act(async () => { (profileTab as HTMLButtonElement).click() })

    expect(text()).toContain('用户画像读取失败')
    expect(text()).not.toContain('还没有用户画像')
    expect(findButtonByText(container, '重试').disabled).toBe(false)
  })

  it('人格接口失败时展示可重试的错误态', async () => {
    installNxcore({ personaFail: true })
    await render('agent')

    expect(text()).toContain('Agent 设定读取失败')
    const retry = findButtonByText(container, '重试')
    expect(retry.disabled).toBe(false)
  })

  it('不再渲染原型以外的区块（本机 Agent / MCP / 用量 / 调试按钮）', async () => {
    installNxcore()
    await render('agent')

    expect(text()).not.toContain('Codex CLI')
    expect(text()).not.toContain('MCP 服务')
    expect(text()).not.toContain('输入 tokens')
    expect(container.querySelectorAll('.wb-home-stat')).toHaveLength(0)
    expect(() => findButtonByText(container, '打开调试窗口')).toThrow()
  })
})

describe('主页侧栏入口', () => {
  it('设置是连接器下面的独立入口，账号行只开账号菜单', async () => {
    installNxcore()
    await act(async () => { root.render(<HomeSidebar />) })
    await flush(2)

    const navLabels = Array.from(container.querySelectorAll('.wb-sidebar-nav .wb-nav-label'))
      .map((el) => el.textContent)
    expect(navLabels).toEqual(['最近', '项目空间', '所有文件', 'Agent', '技能', '连接器', '设置'])

    const account = container.querySelector<HTMLButtonElement>('.wb-account')
    expect(account, '账号行应存在').not.toBeNull()
    // 账号行是菜单触发器，点它不跳设置页。
    expect(account!.getAttribute('aria-haspopup')).toBe('menu')
    expect(container.querySelector('.wb-sidebar-foot .wb-nav-item')).toBeNull()

    await act(async () => { findButtonByText(container, '设置').click() })
    const homeTab = useWorkbenchStore.getState().tabs.find((tab) => tab.kind === 'home')
    expect(homeTab?.kind === 'home' ? homeTab.page : null).toBe('settings')
    // 进设置时高亮的是设置项，不是账号行。
    expect(container.querySelector('.wb-nav-item.is-active')?.textContent).toBe('设置')
    expect(container.querySelector('.wb-account.is-active')).toBeNull()
  })

  it('openSettings 可以把设置页落到指定分区', () => {
    useWorkbenchStore.getState().openSettings('settings-account')
    expect(useWorkbenchStore.getState().settingsSection).toBe('settings-account')
    const homeTab = useWorkbenchStore.getState().tabs.find((tab) => tab.kind === 'home')
    expect(homeTab?.kind === 'home' ? homeTab.page : null).toBe('settings')
  })
})
