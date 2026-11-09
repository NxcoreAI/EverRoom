// @vitest-environment happy-dom
/**
 * 项目空间目录化（P0）渲染层回归：
 * 1) 侧栏「工作空间操作」菜单的「在访达中打开」：reveal 目标来自
 *    `nxcore.workspace.layout`（失败回落 `workspace.path`）；
 * 2) 一步式新建项目空间：点按钮直接弹目录选择器，选完即建（目录名 = 空间名），
 *    已是项目空间的目录走「打开/接管」而不是报错。
 *
 * 与 tests/workbench-workspace-tools.test.tsx 同款 happy-dom + 手动 act/createRoot 写法。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSpaceDetectResult, AgentSpaceLayout, AgentWorkspace } from '@nxcore/agent-contract'

import { useCreateSpaceFlow } from '../src/renderer/src/workbench/workspace/createSpace'
import { WorkspaceSidebar } from '../src/renderer/src/workbench/shell/WorkspaceSidebar'
import { useWorkbenchStore } from '../src/renderer/src/workbench/state/store'
import { onWorkbenchToast } from '../src/renderer/src/workbench/shell/toast'
import type { WorkspaceTab } from '../src/renderer/src/workbench/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-11-02T08:00:00.000Z'
const ROOT = '/Users/wang/Library/Application Support/EverOffice/Workspace/feishu-work'

const WORKSPACE: AgentWorkspace = {
  id: 'ws-feishu',
  name: '飞书相关工作',
  description: null,
  goals: [],
  path: ROOT,
  slug: 'feishu-work',
  rootMode: 'managed',
  layoutVersion: 1,
  rootMissingAt: null,
  kind: 'custom',
  createdAt: ISO,
  updatedAt: ISO,
  lastOpenedAt: ISO,
}

const TAB: WorkspaceTab = {
  id: 'ws:ws-feishu',
  kind: 'workspace',
  workspaceId: 'ws-feishu',
  view: { kind: 'page', page: 'overview' },
}

function layoutOf(overrides: {
  exists?: boolean
  markerPresent?: boolean
  missingDirectories?: string[]
} = {}): AgentSpaceLayout {
  return {
    spaceId: WORKSPACE.id,
    rootMode: 'managed',
    layoutVersion: 2,
    // v2：资料库根 = 空间根，元数据收进 .everoffice/，过程缓存单独放 .tmp/。
    paths: {
      root: ROOT,
      library: ROOT,
      meta: `${ROOT}/.everoffice`,
      memory: `${ROOT}/.everoffice/memory`,
      conversation: `${ROOT}/.everoffice/conversation`,
      trash: `${ROOT}/.everoffice/trash`,
      cache: `${ROOT}/.everoffice/cache`,
      tmp: `${ROOT}/.tmp`,
      derived: `${ROOT}/.everoffice/cache/derived`,
      objects: `${ROOT}/.everoffice/objects`,
    },
    health: {
      root: ROOT,
      exists: overrides.exists ?? true,
      markerPresent: overrides.markerPresent ?? true,
      markerReadonly: false,
      missingDirectories: overrides.missingDirectories ?? [],
    },
    markerPath: `${ROOT}/.everoffice/space.json`,
  }
}

function installNxcore(overrides: {
  layout?: () => Promise<AgentSpaceLayout>
  repair?: () => Promise<{ spaceId: string; createdDirectories: string[]; createdMarker: boolean; readonly: boolean }>
  reveal?: (dir: string) => Promise<boolean>
  defaultRoot?: (name: string) => Promise<{ root: string; slug: string; exists: boolean } | null>
  detect?: (dir: string) => Promise<AgentSpaceDetectResult>
  create?: (input: { name: string; path?: string | null }) => Promise<AgentWorkspace>
  adopt?: (input: { dir: string; name?: string }) => Promise<AgentWorkspace>
  reconcileLibrary?: (workspaceId: string) => Promise<{ spaceId: string; scanned: number; added: string[]; missing: string[]; restored: string[]; failed: never[] }>
  cacheStats?: () => Promise<{ spaceId: string; bound: boolean; tmpBytes: number; derivedBytes: number; objectsBytes: number; totalBytes: number; tmpFiles: number; derivedFiles: number; objectFiles: number }>
  gcCache?: () => Promise<{ spaceId: string; removedTmp: number; removedDerived: number; removedObjects: number; purgedTrash: number; freedBytes: number }>
  scratchFiles?: () => Promise<{
    spaceId: string
    bound: boolean
    present: boolean
    entries: Array<{ path: string; size: number; modifiedAt: string }>
    fileCount: number
    totalBytes: number
    truncated: boolean
  }>
  relocate?: (workspaceId: string, dir: string) => Promise<unknown>
  pickDirectory?: () => Promise<string | null>
} = {}) {
  const api = {
    workspace: {
      layout: vi.fn(overrides.layout ?? (async () => layoutOf())),
      repair: vi.fn(overrides.repair ?? (async () => ({
        spaceId: WORKSPACE.id,
        createdDirectories: [],
        createdMarker: false,
        readonly: false,
      }))),
      reveal: vi.fn(overrides.reveal ?? (async () => true)),
      defaultRoot: vi.fn(overrides.defaultRoot ?? (async (name: string) => ({
        root: `/Users/wang/Library/Application Support/EverOffice/Workspace/${name.trim().toLowerCase().replace(/\s+/gu, '-')}`,
        slug: name.trim().toLowerCase().replace(/\s+/g, '-'),
        exists: false,
      }))),
      detect: vi.fn(overrides.detect ?? (async (): AgentSpaceDetectResult => ({ status: 'missing' as const }))),
      create: vi.fn(overrides.create ?? (async (input: { name: string; path?: string | null }) => ({
        ...WORKSPACE,
        id: 'ws-new',
        name: input.name,
        path: input.path ?? null,
        rootMode: input.path ? 'external' as const : 'managed' as const,
      }))),
      adopt: vi.fn(overrides.adopt ?? (async (input: { dir: string }) => ({
        ...WORKSPACE,
        id: 'ws-adopted',
        path: input.dir,
        rootMode: 'external' as const,
      }))),
      pickDirectory: vi.fn(overrides.pickDirectory ?? (async () => null)),
      reconcileLibrary: vi.fn(overrides.reconcileLibrary ?? (async () => ({
        spaceId: WORKSPACE.id,
        scanned: 0,
        added: [],
        missing: [],
        restored: [],
        failed: [],
      }))),
      cacheStats: vi.fn(overrides.cacheStats ?? (async () => ({
        spaceId: WORKSPACE.id,
        bound: true,
        tmpBytes: 1024 * 1024,
        derivedBytes: 512 * 1024,
        objectsBytes: 0,
        totalBytes: 1536 * 1024,
        tmpFiles: 2,
        derivedFiles: 1,
        objectFiles: 0,
      }))),
      gcCache: vi.fn(overrides.gcCache ?? (async () => ({
        spaceId: WORKSPACE.id,
        removedTmp: 1,
        removedDerived: 0,
        removedObjects: 0,
        purgedTrash: 0,
        freedBytes: 2048,
      }))),
      scratchFiles: vi.fn(overrides.scratchFiles ?? (async () => ({
        spaceId: WORKSPACE.id,
        bound: true,
        present: true,
        entries: [
          { path: 'thesis/run-1/transcript.txt', size: 2048, modifiedAt: new Date().toISOString() },
          { path: 'screenshot.jpg', size: 512, modifiedAt: new Date(Date.now() - 3_600_000).toISOString() },
        ],
        fileCount: 2,
        totalBytes: 2560,
        truncated: false,
      }))),
      relocate: vi.fn(overrides.relocate ?? (async () => ({}))),
    },
    agent: {
      listSessions: vi.fn(async () => []),
    },
  }
  ;(window as unknown as { nxcore?: unknown }).nxcore = api
  return api
}

let container: HTMLDivElement
let root: Root | null = null

async function flush(rounds = 8, step = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

/** 打开 ⋯「工作空间操作」菜单并点某个菜单项（Radix DropdownMenu）。 */
async function openMenuAndClick(itemLabel: string): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="工作空间操作"]')
  if (!trigger) throw new Error('工作空间操作按钮未渲染')
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  })
  await flush()
  const item = [...document.body.querySelectorAll('[role="menuitem"]')]
    .find((element) => (element.textContent ?? '').includes(itemLabel))
  if (!item) throw new Error(`菜单项不存在：${itemLabel}`)
  await act(async () => {
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  useWorkbenchStore.setState({
    workspaces: [WORKSPACE],
    sessions: [],
  })
})

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  container.remove()
  ;(window as unknown as { nxcore?: unknown }).nxcore = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('WorkspaceSidebar · 在访达中打开', () => {
  it('reveals the space root from layout, falling back to workspace.path', async () => {
    const api = installNxcore()
    await act(async () => {
      root = createRoot(container)
      root.render(<WorkspaceSidebar tab={TAB} />)
    })
    await flush()

    await openMenuAndClick('在访达中打开')

    expect(api.workspace.layout).toHaveBeenCalledWith(WORKSPACE.id)
    expect(api.workspace.reveal).toHaveBeenCalledWith(ROOT)
  })

  it('falls back to workspace.path when layout is unavailable', async () => {
    const api = installNxcore({ layout: async () => { throw new Error('409') } })
    await act(async () => {
      root = createRoot(container)
      root.render(<WorkspaceSidebar tab={TAB} />)
    })
    await flush()

    await openMenuAndClick('在访达中打开')

    expect(api.workspace.reveal).toHaveBeenCalledWith(WORKSPACE.path)
  })

  it('toasts when the directory cannot be revealed', async () => {
    installNxcore({ reveal: async () => false })
    const toasts: string[] = []
    const offToast = onWorkbenchToast((message) => toasts.push(message))
    await act(async () => {
      root = createRoot(container)
      root.render(<WorkspaceSidebar tab={TAB} />)
    })
    await flush()

    await openMenuAndClick('在访达中打开')

    expect(toasts).toContain('目录不存在或已被移动')
    offToast()
  })

  it('toasts when the space has no bound directory', async () => {
    const api = installNxcore()
    useWorkbenchStore.setState({
      workspaces: [{ ...WORKSPACE, path: null }],
    })
    const toasts: string[] = []
    const offToast = onWorkbenchToast((message) => toasts.push(message))
    await act(async () => {
      root = createRoot(container)
      root.render(<WorkspaceSidebar tab={TAB} />)
    })
    await flush()

    await openMenuAndClick('在访达中打开')

    expect(api.workspace.reveal).not.toHaveBeenCalled()
    expect(toasts).toContain('这个空间还没有绑定本地目录')
    offToast()
  })
})

describe('一步式新建项目空间（useCreateSpaceFlow）', () => {
  /** 挂载一个真正走 hook 的组件；流程本身不渲染 UI，全部走桥 + store + toast。 */
  async function runFlow(): Promise<void> {
    let trigger: (() => void) | null = null
    function FlowButton() {
      const flow = useCreateSpaceFlow()
      trigger = () => { void flow() }
      return <button type="button" onClick={() => { void flow() }}>新建项目空间</button>
    }
    await act(async () => {
      root = createRoot(container)
      root.render(<FlowButton />)
    })
    if (!trigger) throw new Error('流程触发器未挂载')
    await act(async () => {
      trigger()
    })
    await flush()
  }

  it('选中普通目录：以目录名就地创建，并在后台对账资料', async () => {
    const api = installNxcore({
      pickDirectory: async () => '/Users/wang/Desktop/连接器项目',
      reconcileLibrary: async () => ({
        spaceId: 'ws-new',
        scanned: 3,
        added: ['方案.docx', '报价.xlsx'],
        missing: [],
        restored: [],
        failed: [],
      }),
    })
    const toasts: string[] = []
    const offToast = onWorkbenchToast((message) => toasts.push(message))
    await runFlow()

    expect(api.workspace.pickDirectory).toHaveBeenCalledTimes(1)
    expect(api.workspace.detect).toHaveBeenCalledWith('/Users/wang/Desktop/连接器项目')
    expect(api.workspace.create).toHaveBeenCalledWith({
      name: '连接器项目',
      path: '/Users/wang/Desktop/连接器项目',
    })
    expect(api.workspace.reconcileLibrary).toHaveBeenCalledWith('ws-new')
    expect(toasts.some((message) => message.includes('已创建项目空间「连接器项目」'))).toBe(true)
    expect(toasts).toContain('已把「2」份目录内文件收进资料')
    // 创建后直接打开该空间的标签。
    expect(useWorkbenchStore.getState().tabs.some((tab) =>
      tab.kind === 'workspace' && tab.workspaceId === 'ws-new')).toBe(true)
    offToast()
  })

  it('取消选择器：什么都不发生（不建空间、不报错）', async () => {
    const api = installNxcore({ pickDirectory: async () => null })
    await runFlow()

    expect(api.workspace.create).not.toHaveBeenCalled()
    expect(useWorkbenchStore.getState().error).toBeNull()
  })

  it('目录已是注册过的项目空间：直接打开，不再创建', async () => {
    const api = installNxcore({
      pickDirectory: async () => ROOT,
      detect: async () => ({
        status: 'space' as const,
        root: ROOT,
        spaceId: WORKSPACE.id,
        name: WORKSPACE.name,
        slug: 'feishu-work',
        layoutVersion: 2,
        readonly: false,
      }),
    })
    const toasts: string[] = []
    const offToast = onWorkbenchToast((message) => toasts.push(message))
    await runFlow()

    expect(api.workspace.create).not.toHaveBeenCalled()
    expect(api.workspace.adopt).not.toHaveBeenCalled()
    expect(toasts.some((message) => message.includes('已是项目空间'))).toBe(true)
    expect(useWorkbenchStore.getState().activeTabId).toBe('ws:ws-feishu')
    offToast()
  })

  it('目录有空间标记但未注册：走接管（adopt）', async () => {
    const api = installNxcore({
      pickDirectory: async () => '/Users/wang/Desktop/孤儿空间',
      detect: async () => ({
        status: 'space' as const,
        root: '/Users/wang/Desktop/孤儿空间',
        spaceId: 'orphan-id',
        name: '孤儿空间',
        slug: 'orphan',
        layoutVersion: 2,
        readonly: false,
      }),
    })
    const toasts: string[] = []
    const offToast = onWorkbenchToast((message) => toasts.push(message))
    await runFlow()

    expect(api.workspace.adopt).toHaveBeenCalledWith({ dir: '/Users/wang/Desktop/孤儿空间' })
    expect(api.workspace.create).not.toHaveBeenCalled()
    expect(toasts.some((message) => message.includes('已接管目录为项目空间「飞书相关工作」'))).toBe(true)
    offToast()
  })

  it('创建失败：错误进 store.error，不打成功 toast', async () => {
    const api = installNxcore({
      pickDirectory: async () => '/System/只读目录',
      create: async () => { throw new Error('目录不可写（只读卷 / 权限不足 / 磁盘已满）') },
    })
    const toasts: string[] = []
    const offToast = onWorkbenchToast((message) => toasts.push(message))
    await runFlow()

    expect(useWorkbenchStore.getState().error).toContain('目录不可写')
    expect(toasts).toHaveLength(0)
    expect(api.workspace.reconcileLibrary).not.toHaveBeenCalled()
    offToast()
  })
})
