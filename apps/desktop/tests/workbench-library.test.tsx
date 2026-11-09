// @vitest-environment happy-dom
/**
 * 工作空间「资料 / 产物」页回归测试。
 *
 * 覆盖：
 * 1) 资料：真实文件库渲染 + 目录层级导航 + 搜索 + 网格/列表两种视图 + 空态；
 * 2) 产物页：只列 agent-generated / artifact-imported，按更新时间倒序，点行交给 onOpenFile；
 *    列表/网格与资料页同一套 UI（同一表头/行结构/排序指示，以资料为主）；
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
  buildLibraryLevel,
  folderCrumbs,
  folderLabel,
  parentFolderOf,
  searchLibrary,
} from '../src/renderer/src/workbench/workspace/libraryTree'
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

async function typeSearch(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('.wb-lib-search input')
  if (!input) throw new Error('资料搜索框未渲染')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
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

describe('资料页', () => {
  it('按当前工作空间过滤拉取（list 带 workspaceId）', async () => {
    const props = pageProps()
    const nxcore = installFilesApi(OPENABLE_KINDS)
    await act(async () => { root.render(<LibraryPage {...props} />) })
    await flush()

    expect(nxcore.files.list).toHaveBeenCalledWith(200, 0, { workspaceId: 'ws-1' })
  })

  it('默认网格视图：文件夹在前、文件在后，点子文件夹进入后面包屑可回退', async () => {
    const props = pageProps()
    installFilesApi(OPENABLE_KINDS)
    await act(async () => { root.render(<LibraryPage {...props} />) })
    await flush()

    expect(text('.wb-wspage-title')).toContain('资料')
    // 页头说明段与 badge 计数已删；来源 chips 不再出现在资料
    expect(container.querySelector('.wb-wspage-sub')).toBeNull()
    expect(container.querySelector('.ui-badge')).toBeNull()
    expect(container.querySelector('.wb-file-chip')).toBeNull()

    // 根目录：三个顶层文件夹（agent/排期/设计）+ 根目录文件
    const tiles = allText('.wb-lib-tile-name')
    expect(tiles).toEqual(expect.arrayContaining(['agent', '排期', '设计', ARTIFACT_OUTPUT.file.name]))
    expect(tiles).not.toContain(MANUAL.file.name)
    expect(container.querySelector('.wb-lib-grid')).not.toBeNull()
    expect(container.querySelector('.wb-lib-list')).toBeNull()

    // 文件夹瓦片的 meta 是「直接子项数」，文件瓦片的 meta 是更新时间
    const designTile = [...container.querySelectorAll<HTMLButtonElement>('.wb-lib-tile')]
      .find((tile) => (tile.textContent ?? '').includes('设计'))
    expect(designTile!.querySelector('.wb-lib-tile-meta')!.textContent).toBe('1 项')

    // 点「设计」文件夹：面包屑变成 资料 / 设计，网格里出现该目录下的文件
    await act(async () => { designTile!.click() })
    expect(allText('.wb-lib-crumbs button')).toEqual(['资料', '设计'])
    expect(allText('.wb-lib-tile-name')).toEqual([MANUAL.file.name])

    // 返回上一级回到根目录
    await act(async () => { container.querySelector<HTMLButtonElement>('.wb-lib-back')!.click() })
    expect(allText('.wb-lib-tile-name')).toEqual(
      expect.arrayContaining(['agent', '排期', '设计', ARTIFACT_OUTPUT.file.name]),
    )
    expect(container.querySelector<HTMLButtonElement>('.wb-lib-back')!.disabled).toBe(true)
  })

  it('列表视图：六列表头 + 目录导航 + 点行交给 onOpenFile', async () => {
    const props = pageProps()
    installFilesApi(OPENABLE_KINDS)
    await act(async () => { root.render(<LibraryPage {...props} />) })
    await flush()

    const listButton = container.querySelector<HTMLButtonElement>('button[aria-label="列表视图"]')
    expect(listButton).not.toBeNull()
    await act(async () => { listButton!.click() })

    expect(container.querySelector('.wb-lib-list')).not.toBeNull()
    const head = allText('.wb-lib-head span').filter(Boolean)
    expect(head).toEqual(['名称', '本地位置', '修改时间', '大小'])
    // 「修改时间」带倒序指示（与主页文件表同款；产物页列表是同一套表头）
    expect(container.querySelector('.wb-lib-head .wb-lib-sort')?.textContent).toContain('修改时间')

    // 列表里文件夹排在文件前面，位置列是当前目录
    const names = allText('.wb-lib-name')
    expect(names).toEqual(expect.arrayContaining(['agent', '排期', '设计', ARTIFACT_OUTPUT.file.name]))
    expect(names.indexOf('设计')).toBeLessThan(names.indexOf(ARTIFACT_OUTPUT.file.name))
    expect(allText('.wb-lib-loc')).toEqual(
      expect.arrayContaining(['资料', '资料', '资料', '资料']),
    )

    // 点文件行 → onOpenFile（气泡窗），自己不开编辑器
    const artifactRow = [...container.querySelectorAll<HTMLButtonElement>('.wb-lib-row-main')]
      .find((row) => (row.textContent ?? '').includes(ARTIFACT_OUTPUT.file.name))
    await act(async () => { artifactRow!.click() })
    expect(props.onOpenFile).toHaveBeenCalledTimes(1)
    const opened = (props.onOpenFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as RealOfficeFile['file']
    expect(opened.name).toBe(ARTIFACT_OUTPUT.file.name)
  })

  it('搜索是全库范围：命中文件夹与文件，点文件夹清空搜索并进入', async () => {
    installFilesApi(OPENABLE_KINDS)
    await act(async () => { root.render(<LibraryPage {...pageProps()} />) })
    await flush()

    // 先进入「设计」，证明搜索忽略当前目录
    const designTile = [...container.querySelectorAll<HTMLButtonElement>('.wb-lib-tile')]
      .find((tile) => (tile.textContent ?? '').includes('设计'))
    await act(async () => { designTile!.click() })

    await typeSearch('排期')
    // 搜索中强制列表视图，视图切换禁用
    expect(container.querySelector('.wb-lib-list')).not.toBeNull()
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="网格视图"]')!.disabled).toBe(true)
    expect(allText('.wb-lib-name')).toEqual(expect.arrayContaining(['排期', LOCAL_FOLDER.file.name]))

    // 点命中的文件夹行：清空搜索并进入该目录
    const folderRow = [...container.querySelectorAll<HTMLButtonElement>('.wb-lib-row-main')]
      .find((row) => (row.textContent ?? '').trim().startsWith('排期'))
    await act(async () => { folderRow!.click() })
    expect(container.querySelector<HTMLInputElement>('.wb-lib-search input')!.value).toBe('')
    expect(allText('.wb-lib-crumbs button')).toEqual(['资料', '排期'])
    expect(allText('.wb-lib-tile-name')).toEqual([LOCAL_FOLDER.file.name])

    // 无命中时给出明确文案
    await typeSearch('不存在的文件')
    expect(text('.wb-lib-empty')).toContain('没有匹配「不存在的文件」的结果')
  })

  it('排版产物落库后自动刷新资料（别的空间不打扰）', async () => {
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
    // 没有文件时工具行（面包屑/搜索/视图切换）也不出现
    expect(container.querySelector('.wb-lib-tile')).toBeNull()
    expect(container.querySelector('.wb-lib-bar')).toBeNull()
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
    // 导入的文件落在 `设计/` 目录，根目录出现对应文件夹瓦片
    expect(allText('.wb-lib-tile-name')).toEqual(['设计'])
    expect(nxcore.files.list).toHaveBeenCalledTimes(2)

    const folderTile = [...container.querySelectorAll<HTMLButtonElement>('.wb-lib-tile')]
      .find((tile) => (tile.textContent ?? '').includes('设计'))
    await act(async () => { folderTile!.click() })
    expect(allText('.wb-lib-tile-name')).toEqual([MANUAL.file.name])
  })

  it('文件库拉取失败时显示不可用态', async () => {
    const props = pageProps()
    ;(window as unknown as { nxcore: unknown }).nxcore = {
      files: { list: vi.fn().mockRejectedValue(new Error('gateway down')) },
    }
    await act(async () => { root.render(<LibraryPage {...props} />) })
    await flush()

    expect(container.textContent).toContain('资料暂不可用')
    // 不可用态只留一句事实 + 重试按钮，不再展开解释
    expect(container.querySelector('.ui-empty-desc')).toBeNull()
    expect(container.querySelector('.wb-lib-tile')).toBeNull()
  })

  it('从访达拖文件进来：dragover 高亮，drop 调 importDropped 并按当前空间刷新', async () => {
    const props = pageProps()
    const nxcore = installFilesApi([], 0)
    nxcore.files.importDropped = vi.fn().mockResolvedValue([
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
    nxcore.files.list
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValue({ items: [MANUAL.catalog], total: 1 })

    await act(async () => { root.render(<LibraryPage {...props} />) })
    await flush()

    // 空库也要能拖：落点是页面根节点（.wb-library-page），不依赖浏览器内容区。
    const dropTarget = container.querySelector<HTMLElement>('.wb-library-page')
    expect(dropTarget).not.toBeNull()
    const dragFile = new File(['hello'], '拖进来的文档.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })

    const dataTransfer = {
      types: ['Files'],
      files: { length: 1, 0: dragFile, item: () => dragFile, [Symbol.iterator]: Array.prototype[Symbol.iterator] } as unknown as FileList,
    }
    // dragenter → 高亮态出现（happy-dom 的 DragEvent 不接 dataTransfer，用属性注入）
    const fireDrag = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      dropTarget!.dispatchEvent(event)
    }
    await act(async () => { fireDrag('dragenter') })
    expect(dropTarget!.className).toContain('is-dragover')
    expect(container.querySelector('.wb-lib-dropzone')).not.toBeNull()

    // drop → importDropped(files, { workspaceId })，完成后刷新并 toast
    await act(async () => { fireDrag('drop') })
    await flush()

    expect(nxcore.files.importDropped).toHaveBeenCalledTimes(1)
    const call = (nxcore.files.importDropped as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[1]).toEqual({ workspaceId: 'ws-1' })
    expect(props.onToast).toHaveBeenCalledWith('已导入 1 个文件')
    expect(allText('.wb-lib-tile-name')).toEqual(['设计'])
  })

  it('拖放导入没有桥（importDropped 缺失）时提示不可用，不静默失败', async () => {
    const props = pageProps()
    installFilesApi(OPENABLE_KINDS)
    await act(async () => { root.render(<LibraryPage {...props} />) })
    await flush()

    const dropTarget = container.querySelector<HTMLElement>('.wb-library-page')
    expect(dropTarget).not.toBeNull()
    const dragFile = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    const dataTransfer = {
      types: ['Files'],
      files: { length: 1, 0: dragFile, item: () => dragFile, [Symbol.iterator]: Array.prototype[Symbol.iterator] } as unknown as FileList,
    }
    await act(async () => {
      const drop = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
      dropTarget!.dispatchEvent(drop)
    })
    await flush()

    expect(props.onToast).toHaveBeenCalledWith('资料暂不可用，无法导入')
  })
})

describe('产物页', () => {
  it('只列 agent-generated / artifact-imported，按更新时间倒序，点开走 onOpenFile', async () => {
    const props = pageProps({ tab: { id: 'ws:ws-1', kind: 'workspace', workspaceId: 'ws-1', view: { kind: 'page', page: 'outputs' } } })
    installFilesApi(OPENABLE_KINDS)
    await act(async () => { root.render(<OutputsPage {...props} />) })
    await flush()

    // 网格与资料页同一套瓦片（.wb-lib-tile），顺序仍是更新时间倒序
    const names = allText('.wb-lib-tile-name')
    expect(names).toEqual([AGENT_OUTPUT.file.name, ARTIFACT_OUTPUT.file.name])
    expect(names).not.toContain(MANUAL.file.name)
    expect(names).not.toContain(LOCAL_FOLDER.file.name)
    // 页头说明段与 badge 计数已删；计数只在筛选 chip 上
    expect(container.querySelector('.wb-wspage-sub')).toBeNull()
    expect(container.querySelector('.ui-badge')).toBeNull()
    const allChip = [...container.querySelectorAll<HTMLButtonElement>('.wb-file-chip')]
      .find((chip) => (chip.textContent ?? '').includes('全部产物'))
    expect(allChip!.textContent).toContain('2')

    const firstTile = container.querySelector<HTMLButtonElement>('.wb-lib-tile')
    await act(async () => { firstTile!.click() })
    expect(props.onOpenFile).toHaveBeenCalledTimes(1)
    const opened = (props.onOpenFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as RealOfficeFile['file']
    expect(opened.name).toBe(AGENT_OUTPUT.file.name)
  })

  it('列表视图与资料页同一套表头/行结构/排序指示（以资料为主）', async () => {
    const props = pageProps({ tab: { id: 'ws:ws-1', kind: 'workspace', workspaceId: 'ws-1', view: { kind: 'page', page: 'outputs' } } })
    installFilesApi(OPENABLE_KINDS)
    await act(async () => { root.render(<OutputsPage {...props} />) })
    await flush()

    const listButton = container.querySelector<HTMLButtonElement>('button[aria-label="列表视图"]')
    expect(listButton).not.toBeNull()
    await act(async () => { listButton!.click() })

    // 同一张六列表格：表头列名 + 「修改时间」倒序指示与资料页完全一致
    expect(container.querySelector('.wb-lib-list')).not.toBeNull()
    expect(allText('.wb-lib-head span').filter(Boolean)).toEqual(['名称', '本地位置', '修改时间', '大小'])
    expect(container.querySelector('.wb-lib-head .wb-lib-sort')?.textContent).toContain('修改时间')

    // 行序：更新时间倒序；位置列与资料同口径（relativePath 派生，根目录显示「资料」）
    expect(allText('.wb-lib-name')).toEqual([AGENT_OUTPUT.file.name, ARTIFACT_OUTPUT.file.name])
    expect(allText('.wb-lib-loc')).toEqual(['agent', '资料'])

    // 点文件行 → onOpenFile（气泡窗），自己不开编辑器
    const firstRow = container.querySelector<HTMLButtonElement>('.wb-lib-row-main')
    await act(async () => { firstRow!.click() })
    expect(props.onOpenFile).toHaveBeenCalledTimes(1)
    const opened = (props.onOpenFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as RealOfficeFile['file']
    expect(opened.name).toBe(AGENT_OUTPUT.file.name)
  })

  it('没有产物时：页头「去资料」只出现一次，空态只留「新建工作」', async () => {
    const props = pageProps()
    installFilesApi([MANUAL], 1)
    await act(async () => { root.render(<OutputsPage {...props} />) })
    await flush()

    expect(container.textContent).toContain('还没有产物')
    expect(container.querySelector('.ui-empty-desc')).toBeNull()
    // 空态不再重复页头的「去资料」
    const libraryButtons = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => (button.textContent ?? '').trim().includes('去资料'))
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

    expect(container.textContent).toContain('资料暂不可用')
  })
})

describe('资料目录树 / 搜索纯函数', () => {
  it('目录层级从 relativePath 派生：根层只有直接子文件夹与根文件', () => {
    const level = buildLibraryLevel(OPENABLE_KINDS, '')
    expect(level.path).toBe('')
    expect(level.folders.map((folder) => folder.name)).toEqual(['排期', '设计', 'agent'])
    expect(level.folders.every((folder) => folder.fileCount === 1)).toBe(true)
    expect(level.files.map((item) => item.catalog.id)).toEqual(['f-artifact'])

    const design = buildLibraryLevel(OPENABLE_KINDS, '设计')
    expect(design.files.map((item) => item.catalog.id)).toEqual(['f-manual'])
    expect(design.folders).toEqual([])

    // 不存在的目录返回空层，而不是抛错
    expect(buildLibraryLevel(OPENABLE_KINDS, '不存在').folders).toEqual([])
    expect(buildLibraryLevel(OPENABLE_KINDS, '不存在').files).toEqual([])
  })

  it('多级目录：中间层只有子文件夹，计数只算直接子文件', () => {
    const deep = realFile({ id: 'f-deep', originalName: 'spec.md', relativePath: 'docs/api/spec.md' })
    const items = [...OPENABLE_KINDS, deep]

    const root = buildLibraryLevel(items, '')
    expect(root.folders.map((folder) => folder.name)).toContain('docs')
    expect(root.folders.find((folder) => folder.name === 'docs')!.fileCount).toBe(0)

    const docs = buildLibraryLevel(items, 'docs')
    expect(docs.folders.map((folder) => folder.name)).toEqual(['api'])
    expect(docs.folders[0].path).toBe('docs/api')
    expect(docs.files).toEqual([])

    expect(folderCrumbs('docs/api').map((crumb) => crumb.name)).toEqual(['docs', 'api'])
    expect(parentFolderOf('docs/api')).toBe('docs')
    expect(parentFolderOf('docs')).toBe('')
    expect(folderLabel('docs/api')).toBe('docs / api')
    expect(folderLabel('')).toBe('资料')
  })

  it('搜索是全库范围：文件夹按名称、文件按名称/路径命中，均带位置文案', () => {
    const byFolder = searchLibrary(OPENABLE_KINDS, '排期')
    expect(byFolder.folders.map((row) => row.kind === 'folder' && row.name)).toEqual(['排期'])
    expect(byFolder.folders[0]).toMatchObject({ location: '资料', fileCount: 1 })
    // 「排期」同时命中文件名里的「排期」（周报：连接器统一排期）
    expect(byFolder.files.map((row) => row.kind === 'file' && row.item.catalog.id)).toEqual(['f-local', 'f-agent'])

    // 按路径命中文件（关键词只在相对路径里）
    const byPath = searchLibrary(OPENABLE_KINDS, 'agent/')
    expect(byPath.files.map((row) => row.kind === 'file' && row.item.catalog.id)).toEqual(['f-agent'])
    expect(byPath.files[0]).toMatchObject({ location: 'agent' })

    expect(searchLibrary(OPENABLE_KINDS, '不存在的文件')).toEqual({ folders: [], files: [] })
    expect(searchLibrary(OPENABLE_KINDS, '   ')).toEqual({ folders: [], files: [] })
  })
})
