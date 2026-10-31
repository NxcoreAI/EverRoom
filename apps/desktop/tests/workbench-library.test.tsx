// @vitest-environment happy-dom
/**
 * 工作空间「资料库 / 产物」页回归测试。
 *
 * 覆盖：
 * 1) 资料库：真实文件库渲染 + 来源筛选（手动上传/本地文件夹/连接器/Agent 生成）+ 空态；
 * 2) 产物页：只列 agent-generated / artifact-imported，按更新时间倒序，点卡片交给 onOpenFile；
 * 3) 文件库拉取失败（/没有桥）时两个页面都渲染「不可用」态，而不是空白或假数据；
 * 4) 筛选/分类纯函数口径（legacy-upload 归手动上传、artifact-imported 只出现在「全部」）。
 *
 * 写法与 tests/workbench-tabs.test.ts / office-proto-*.test.tsx 一致：
 * happy-dom + 手动 act/createRoot，不引入 testing-library。
 */
import type { AgentWorkspace } from '@nxcore/agent-contract'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileCatalogDto } from '@/shared/ingest'

import { catalogToOfficeFile, type RealOfficeFile } from '../src/renderer/src/office-proto/data'
import { LibraryPage } from '../src/renderer/src/workbench/workspace/LibraryPage'
import { OutputsPage } from '../src/renderer/src/workbench/workspace/OutputsPage'
import {
  countSourceFilters,
  fileSourceGroup,
  filterLibraryFiles,
} from '../src/renderer/src/workbench/workspace/fileBrowser'
import type { WorkspacePageProps } from '../src/renderer/src/workbench/workspace/contracts'

// React 18 的 act() 需要显式声明测试环境。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKSPACE: AgentWorkspace = {
  id: 'ws-1',
  name: '连接器项目',
  description: null,
  goals: [],
  path: null,
  kind: 'custom',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lastOpenedAt: '2026-10-01T00:00:00.000Z',
}

function catalog(over: Partial<FileCatalogDto> & { id: string }): FileCatalogDto {
  return {
    originalName: `${over.id}.docx`,
    displayName: null,
    sharedTitle: over.id,
    sourceKind: 'manual-upload',
    sourceLabel: '本地上传',
    relativePath: null,
    provider: null,
    bytes: 2048,
    dataType: null,
    agentCategory: null,
    summary: null,
    tags: [],
    processingState: 'ready',
    clusterId: null,
    contentHash: `hash-${over.id}`,
    currentVersionId: null,
    parsed: true,
    updatedAt: '2026-10-28T00:00:00.000Z',
    ...over,
  }
}

function realFile(over: Partial<FileCatalogDto> & { id: string }): RealOfficeFile {
  const item = catalogToOfficeFile(catalog(over))
  if (!item) throw new Error(`无法映射成可打开文件：${over.id}`)
  return item
}

const MANUAL = realFile({
  id: 'f-manual',
  originalName: '设计规范.docx',
  sourceKind: 'manual-upload',
  sourceLabel: '本地上传',
  relativePath: '设计/设计规范.docx',
  updatedAt: '2026-10-28T00:00:00.000Z',
})
const LOCAL_FOLDER = realFile({
  id: 'f-local',
  originalName: '排期表.xlsx',
  sourceKind: 'local-folder',
  sourceLabel: '本地文件夹 · 项目资料',
  relativePath: '排期/排期表.xlsx',
  updatedAt: '2026-10-27T00:00:00.000Z',
})
const AGENT_OUTPUT = realFile({
  id: 'f-agent',
  originalName: '周报：连接器统一排期.docx',
  sourceKind: 'agent-generated',
  sourceLabel: 'Agent 生成',
  relativePath: 'agent/周报：连接器统一排期.docx',
  updatedAt: '2026-10-30T09:00:00.000Z',
})
const ARTIFACT_OUTPUT = realFile({
  id: 'f-artifact',
  originalName: '汇报稿.pptx',
  sourceKind: 'artifact-imported',
  sourceLabel: '产物导入',
  relativePath: null,
  updatedAt: '2026-10-29T00:00:00.000Z',
})

const OPENABLE_KINDS = [MANUAL, LOCAL_FOLDER, AGENT_OUTPUT, ARTIFACT_OUTPUT]

let container: HTMLDivElement
let root: Root

async function flush(rounds = 12, step = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

function pageProps(over: Partial<WorkspacePageProps> = {}): WorkspacePageProps {
  return {
    tab: { id: 'ws:ws-1', kind: 'workspace', workspaceId: 'ws-1', view: { kind: 'page', page: 'library' } },
    workspace: WORKSPACE,
    sessions: [],
    onOpenSession: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenPage: vi.fn(),
    onNewWork: vi.fn(),
    onToast: vi.fn(),
    ...over,
  }
}

function installFilesApi(items: RealOfficeFile[], total = items.length) {
  const nxcore = {
    files: {
      list: vi.fn().mockResolvedValue({ items: items.map((item) => item.catalog), total }),
      pickAndImport: vi.fn().mockResolvedValue([]),
      openOriginal: vi.fn().mockResolvedValue({ openedWith: 'external' as const }),
      exportReveal: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue({ deleted: true }),
    },
  }
  ;(window as unknown as { nxcore: unknown }).nxcore = nxcore
  return nxcore
}
function text(selector: string): string {
  return container.querySelector(selector)?.textContent ?? ''
}

function allText(selector: string): string[] {
  return [...container.querySelectorAll(selector)].map((node) => node.textContent ?? '')
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => (button.textContent ?? '').trim().includes(label))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  delete (window as unknown as { nxcore?: unknown }).nxcore
})

describe('资料库页', () => {
  it('按当前工作空间过滤拉取（list 带 workspaceId）', async () => {
    const props = pageProps()
    const nxcore = installFilesApi(OPENABLE_KINDS)
    await act(async () => { root.render(<LibraryPage {...props} />) })
    await flush()

    expect(nxcore.files.list).toHaveBeenCalledWith(200, 0, { workspaceId: 'ws-1' })
  })

  it('渲染文件列表与 chip 计数（页头不再重复计数），来源筛选生效', async () => {
    const props = pageProps()
    installFilesApi(OPENABLE_KINDS)
    await act(async () => { root.render(<LibraryPage {...props} />) })
    await flush()

    expect(text('.wb-wspage-title')).toContain('资料库')
    // 页头说明段与 badge 计数已删；计数只出现在可交互的筛选 chip 上
    expect(container.querySelector('.wb-wspage-sub')).toBeNull()
    expect(container.querySelector('.ui-badge')).toBeNull()
    const allChip = [...container.querySelectorAll<HTMLButtonElement>('.wb-file-chip')]
      .find((chip) => (chip.textContent ?? '').includes('全部'))
    expect(allChip!.textContent).toContain('4')
    // 默认「全部」列表按目录分组：三条不同相对目录 + 一条根目录
    expect(allText('.wb-file-group-label')).toEqual(
      expect.arrayContaining(['设计', '排期', 'agent', '文件库根目录']),
    )
    const names = allText('.wb-file-row-title')
    expect(names).toEqual(expect.arrayContaining(OPENABLE_KINDS.map((item) => item.file.name)))

    // 切到「Agent 生成」：只剩 agent-generated，chip 计数也正确
    const agentChip = [...container.querySelectorAll<HTMLButtonElement>('.wb-file-chip')]
      .find((chip) => (chip.textContent ?? '').includes('Agent 生成'))
    expect(agentChip).toBeTruthy()
    expect(agentChip!.textContent).toContain('1')
    await act(async () => { agentChip!.click() })
    expect(allText('.wb-file-row-title')).toEqual([AGENT_OUTPUT.file.name])

    // 切到「本地文件夹」
    const localChip = [...container.querySelectorAll<HTMLButtonElement>('.wb-file-chip')]
      .find((chip) => (chip.textContent ?? '').includes('本地文件夹'))
    await act(async () => { localChip!.click() })
    expect(allText('.wb-file-row-title')).toEqual([LOCAL_FOLDER.file.name])
  })

  it('点列表行把文件交给 onOpenFile（气泡窗），自己不开编辑器', async () => {
    const props = pageProps()
    installFilesApi(OPENABLE_KINDS)
    await act(async () => { root.render(<LibraryPage {...props} />) })
    await flush()

    const firstRow = container.querySelector<HTMLButtonElement>('.wb-file-row-main')
    expect(firstRow).not.toBeNull()
    await act(async () => { firstRow!.click() })

    expect(props.onOpenFile).toHaveBeenCalledTimes(1)
    const opened = (props.onOpenFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as RealOfficeFile['file']
    expect(opened.id.startsWith('real:')).toBe(true)
    expect(OPENABLE_KINDS.map((item) => item.file.name)).toContain(opened.name)
  })

  it('排版产物落库后自动刷新资料库（别的空间不打扰）', async () => {
    const props = pageProps()
    const nxcore = installFilesApi(OPENABLE_KINDS)
    let listener: ((event: { type: string; workspaceId?: string }) => void) | null = null
    ;(nxcore as unknown as { office: unknown }).office = {
      onAgentFile: (callback: (event: { type: string; workspaceId?: string }) => void) => {
        listener = callback
        return () => { listener = null }
      },
    }
    await act(async () => { root.render(<LibraryPage {...props} />) })
    await flush()

    const initialCalls = nxcore.files.list.mock.calls.length
    await act(async () => { listener?.({ type: 'done', workspaceId: 'ws-1' }) })
    await flush()
    expect(nxcore.files.list.mock.calls.length).toBeGreaterThan(initialCalls)

    // 别的空间的成品不触发当前列表刷新。
    const afterOwnSpace = nxcore.files.list.mock.calls.length
    await act(async () => { listener?.({ type: 'done', workspaceId: 'ws-2' }) })
    await flush()
    expect(nxcore.files.list.mock.calls.length).toBe(afterOwnSpace)
  })

  it('空文件库显示空态与导入入口', async () => {
    const props = pageProps()
    installFilesApi([], 0)
    await act(async () => { root.render(<LibraryPage {...props} />) })
    await flush()

    expect(container.textContent).toContain('本空间还没有文件')
    // 空态只留标题：说明删掉，导入按钮不重复页头
    expect(container.querySelector('.ui-empty-desc')).toBeNull()
    expect(
      [...container.querySelectorAll('button')].filter((button) => (button.textContent ?? '').includes('导入文件')),
    ).toHaveLength(1)
    expect(buttonByText('导入文件')).toBeTruthy()
    expect(container.querySelector('.wb-file-row-main')).toBeNull()
  })

  it('导入文件后 toast 汇总并刷新列表', async () => {
    const props = pageProps()
    const nxcore = installFilesApi([], 0)
    nxcore.files.list
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValue({ items: [MANUAL.catalog], total: 1 })
    nxcore.files.pickAndImport.mockResolvedValue([
      {
        filename: MANUAL.file.name,
        fileId: 'f-manual',
        fileVersionId: 'v1',
        eventId: 'e1',
        dataType: null,
        deduped: false,
        skippedReason: null,
        pipelines: null,
        memoryResult: null,
        routeJobId: null,
        error: null,
      },
    ])

    await act(async () => { root.render(<LibraryPage {...props} />) })
    await flush()
    await act(async () => { buttonByText('导入文件')!.click() })
    await flush()

    expect(props.onToast).toHaveBeenCalledWith('已导入 1 个文件')
    expect(allText('.wb-file-row-title')).toEqual([MANUAL.file.name])
    expect(nxcore.files.list).toHaveBeenCalledTimes(2)
  })

  it('文件库拉取失败时显示不可用态', async () => {
    const props = pageProps()
    ;(window as unknown as { nxcore: unknown }).nxcore = {
      files: { list: vi.fn().mockRejectedValue(new Error('gateway down')) },
    }
    await act(async () => { root.render(<LibraryPage {...props} />) })
    await flush()

    expect(container.textContent).toContain('文件库暂不可用')
    // 不可用态只留一句事实 + 重试按钮，不再展开解释
    expect(container.querySelector('.ui-empty-desc')).toBeNull()
    expect(container.querySelector('.wb-file-row-main')).toBeNull()
  })
})

describe('产物页', () => {
  it('只列 agent-generated / artifact-imported，按更新时间倒序，点开走 onOpenFile', async () => {
    const props = pageProps({ tab: { id: 'ws:ws-1', kind: 'workspace', workspaceId: 'ws-1', view: { kind: 'page', page: 'outputs' } } })
    installFilesApi(OPENABLE_KINDS)
    await act(async () => { root.render(<OutputsPage {...props} />) })
    await flush()

    const names = allText('.wb-file-card-name')
    expect(names).toEqual([AGENT_OUTPUT.file.name, ARTIFACT_OUTPUT.file.name])
    expect(names).not.toContain(MANUAL.file.name)
    expect(names).not.toContain(LOCAL_FOLDER.file.name)
    // 页头说明段与 badge 计数已删；计数只在筛选 chip 上
    expect(container.querySelector('.wb-wspage-sub')).toBeNull()
    expect(container.querySelector('.ui-badge')).toBeNull()
    const allChip = [...container.querySelectorAll<HTMLButtonElement>('.wb-file-chip')]
      .find((chip) => (chip.textContent ?? '').includes('全部产物'))
    expect(allChip!.textContent).toContain('2')

    const firstCard = container.querySelector<HTMLButtonElement>('.wb-file-card-main')
    await act(async () => { firstCard!.click() })
    expect(props.onOpenFile).toHaveBeenCalledTimes(1)
    const opened = (props.onOpenFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as RealOfficeFile['file']
    expect(opened.name).toBe(AGENT_OUTPUT.file.name)
  })

  it('没有产物时：页头「去资料库」只出现一次，空态只留「新建工作」', async () => {
    const props = pageProps()
    installFilesApi([MANUAL], 1)
    await act(async () => { root.render(<OutputsPage {...props} />) })
    await flush()

    expect(container.textContent).toContain('还没有产物')
    expect(container.querySelector('.ui-empty-desc')).toBeNull()
    // 空态不再重复页头的「去资料库」
    const libraryButtons = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => (button.textContent ?? '').trim().includes('去资料库'))
    expect(libraryButtons).toHaveLength(1)
    await act(async () => { libraryButtons[0].click() })
    expect(props.onOpenPage).toHaveBeenCalledWith('library')

    const newWorkButton = buttonByText('新建工作')
    await act(async () => { newWorkButton!.click() })
    expect(props.onNewWork).toHaveBeenCalledTimes(1)
  })

  it('无 preload 桥（浏览器预览）时显示不可用态', async () => {
    await act(async () => { root.render(<OutputsPage {...pageProps()} />) })
    await flush()

    expect(container.textContent).toContain('文件库暂不可用')
  })
})

describe('来源分类 / 筛选纯函数', () => {
  it('sourceKind 归类：legacy-upload 归手动上传，artifact-imported/web-clipper 只在「全部」', () => {
    expect(fileSourceGroup(catalog({ id: 'a', sourceKind: 'manual-upload' }))).toBe('manual')
    expect(fileSourceGroup(catalog({ id: 'b', sourceKind: 'legacy-upload' }))).toBe('manual')
    expect(fileSourceGroup(catalog({ id: 'c', sourceKind: 'local-folder' }))).toBe('local-folder')
    expect(fileSourceGroup(catalog({ id: 'd', sourceKind: 'connector' }))).toBe('connector')
    expect(fileSourceGroup(catalog({ id: 'e', sourceKind: 'agent-generated' }))).toBe('agent')
    expect(fileSourceGroup(catalog({ id: 'f', sourceKind: 'artifact-imported' }))).toBe('all')
    expect(fileSourceGroup(catalog({ id: 'g', sourceKind: 'web-clipper' }))).toBe('all')
  })

  it('筛选计数 + 搜索（文件名/相对路径/标签）', () => {
    const counts = countSourceFilters(OPENABLE_KINDS)
    expect(counts).toMatchObject({ all: 4, manual: 1, 'local-folder': 1, connector: 0, agent: 1 })

    const byName = filterLibraryFiles(OPENABLE_KINDS, '汇报稿', 'all')
    expect(byName.map((item) => item.catalog.id)).toEqual(['f-artifact'])

    const byPath = filterLibraryFiles(OPENABLE_KINDS, '排期/', 'all')
    expect(byPath.map((item) => item.catalog.id)).toEqual(['f-local'])

    const agentOnly = filterLibraryFiles(OPENABLE_KINDS, '', 'agent')
    expect(agentOnly.map((item) => item.catalog.id)).toEqual(['f-agent'])

    expect(filterLibraryFiles(OPENABLE_KINDS, '不存在的文件', 'all')).toEqual([])
  })
})
