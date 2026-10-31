// @vitest-environment happy-dom
/**
 * 主页标签六页（最近 / 项目空间 / 所有文件 / Agent / 连接器 / 设置）的渲染测试。
 *
 * 数据全部来自真实桥的形状（mock `window.nxcore`），不引入 testing-library：
 * 与 tests/office-proto-recent-view.test.tsx 同款 `react` act + createRoot 手写渲染。
 *
 * 覆盖：
 * 1. 最近页：真实文件库计数/项目空间数/最近会话/最近文件，且不出现「3 封新邮件」类假数据；
 * 2. 所有文件页：来源筛选、文件名搜索、列表/网格切换、点开文件进窗口级文件标签；
 * 3. 文件库失败 → 「文件库暂不可用」（不回退 mock 文件）；
 * 4. 项目空间空态 + 「新建项目空间」走全局事件；
 * 5. 项目空间列表：真实工作数/描述摘要、默认空间不可删、行内重命名写回；
 * 6. Agent 页：主 Agent 状态、本机 Agent、MCP 服务数、近 7 天用量、打开调试窗口。
 */
import type { AgentSession, AgentWorkspace } from '@nxcore/agent-contract'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileCatalogDto } from '../src/shared/ingest'
import { HomePageHost } from '../src/renderer/src/workbench/home/HomePageHost'
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
    ...overrides,
  }
}

/* ───────────────── 桥 mock ───────────────── */

interface NxcoreOptions {
  catalogs?: FileCatalogDto[]
  total?: number
  filesFail?: boolean
  workspaces?: AgentWorkspace[]
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
      discoverLocalAgents: vi.fn().mockResolvedValue(SAMPLE_LOCAL_AGENTS),
      getUsage: vi.fn().mockResolvedValue(SAMPLE_USAGE),
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

    const subtitle = container.querySelector('.ui-pagehead-sub')?.textContent ?? ''
    expect(subtitle).toContain('文件库 7 个文件')
    expect(subtitle).toContain('2 个项目空间')

    expect(text()).toContain('整理连接器排期')
    expect(text()).toContain('项目周报.docx')
    expect(text()).toContain('连接器项目')
    expect(text()).toContain('统一连接器品牌与排期')

    // 假数据治理：不再出现「今天有 3 封新邮件…」这类无数据支撑的文案。
    expect(text()).not.toContain('封新邮件')
    expect(text()).not.toContain('每日洞察')

    // 最近空间：2 个真实空间 + 1 张「新建项目空间」卡。
    expect(container.querySelectorAll('.wb-home-space-card').length).toBe(3)

    // 点最近文件 → 打开窗口级文件标签。
    const fileRow = [...container.querySelectorAll<HTMLButtonElement>('.wb-home-row')]
      .find((row) => (row.textContent ?? '').includes('项目周报.docx'))
    expect(fileRow, '最近文件行应存在').toBeTruthy()
    await act(async () => { fileRow!.click() })
    await flush(2)
    expect(useWorkbenchStore.getState().activeTabId).toBe('file:real:file-1')
  })
})

describe('所有文件页', () => {
  const catalogs = [
    makeCatalog({ id: 'file-doc', originalName: '本周周报.docx', sourceKind: 'manual-upload', sourceLabel: '本地上传' }),
    makeCatalog({ id: 'file-sheet', originalName: '季度汇总.xlsx', sourceKind: 'agent-generated', sourceLabel: 'Agent 生成' }),
    makeCatalog({ id: 'file-pdf', originalName: '外部报告.pdf', sourceKind: 'connector', sourceLabel: '连接器' }),
  ]

  it('按来源筛选 + 文件名搜索 + 列表/网格切换', async () => {
    installNxcore({ catalogs, total: 3 })
    await render('files')

    expect(container.querySelectorAll('.wb-home-list .wb-home-row').length).toBe(3)

    // 来源筛选：只留 Agent 生成。
    await act(async () => { findButtonByText(container, 'Agent 生成').click() })
    await flush(2)
    let rows = [...container.querySelectorAll<HTMLButtonElement>('.wb-home-list .wb-home-row')]
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('季度汇总.xlsx')

    // 回到全部后再按文件名搜索。
    await act(async () => { findButtonByText(container, '全部').click() })
    await flush(2)
    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索文件"]')
    expect(search).toBeTruthy()
    await typeInto(search!, '周报')
    rows = [...container.querySelectorAll<HTMLButtonElement>('.wb-home-list .wb-home-row')]
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('本周周报.docx')

    // 网格视图：同一批数据渲染成文件瓦片。
    await act(async () => { findButtonByText(container, '网格').click() })
    await flush(2)
    const tiles = container.querySelectorAll('.wb-home-file-tile')
    expect(tiles.length).toBe(1)
    expect(tiles[0].textContent).toContain('本周周报.docx')

    // 点瓦片 → 窗口级文件标签。
    await act(async () => { (tiles[0] as HTMLButtonElement).click() })
    await flush(2)
    expect(useWorkbenchStore.getState().activeTabId).toBe('file:real:file-doc')
  })

  it('文件库失败时显示「暂不可用」，不回退 mock 文件', async () => {
    installNxcore({ filesFail: true })
    await render('files')

    expect(text()).toContain('文件库暂不可用')
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
  it('展示主 Agent / 本机 Agent / MCP 服务 / 近 7 天用量，并能打开调试窗口', async () => {
    const nxcore = installNxcore()
    await render('agent')

    expect(text()).toContain('主 Agent')
    expect(text()).toContain('Agent 总数')
    expect(text()).toContain('Codex CLI')
    expect(text()).toContain('MCP 服务')
    expect(text()).toContain('filesystem')
    // 2 个 MCP 服务（1 个停用）。
    expect(container.querySelectorAll('.wb-home-stat').length).toBeGreaterThanOrEqual(7)
    expect(text()).toContain('输入 tokens')
    expect(text()).toContain('1,200')

    const debugButton = findButtonByText(container, '打开调试窗口')
    expect(debugButton.disabled).toBe(false)
    await act(async () => { debugButton.click() })
    await flush(2)
    expect(nxcore.agentDebug.openWindow).toHaveBeenCalledTimes(1)
  })
})
