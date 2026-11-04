// @vitest-environment happy-dom
/**
 * 项目空间目录化（P0）渲染层回归：
 * 1) 侧栏「工作空间操作」菜单的「在访达中打开」：reveal 目标来自
 *    `nxcore.workspace.layout`（失败回落 `workspace.path`）；
 * 2) 新建弹窗：不选目录时显示默认落点 `<dataDir>/Workspace/<slug>` 预览（来自 `workspace.defaultRoot`）。
 *
 * 与 tests/workbench-workspace-tools.test.tsx 同款 happy-dom + 手动 act/createRoot 写法。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSpaceLayout, AgentWorkspace } from '@nxcore/agent-contract'

import { CreateWorkspaceDialog } from '../src/renderer/src/workbench/workspace/CreateWorkspaceDialog'
import { WorkspaceSidebar } from '../src/renderer/src/workbench/shell/WorkspaceSidebar'
import { useWorkbenchStore } from '../src/renderer/src/workbench/state/store'
import { onWorkbenchToast } from '../src/renderer/src/workbench/shell/toast'
import type { WorkspaceTab } from '../src/renderer/src/workbench/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-11-02T08:00:00.000Z'
const ROOT = '/Users/wang/Library/Application Support/EverRoom/Workspace/feishu-work'

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
  reconcileLibrary?: () => Promise<{ spaceId: string; scanned: number; added: string[]; missing: string[]; restored: string[]; failed: never[] }>
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
        root: `/Users/wang/Library/Application Support/EverRoom/Workspace/${name.trim().toLowerCase().replace(/\s+/gu, '-')}`,
        slug: name.trim().toLowerCase().replace(/\s+/g, '-'),
        exists: false,
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

describe('CreateWorkspaceDialog', () => {
  it('previews the default directory under the app Workspace root', async () => {
    const api = installNxcore()
    await act(async () => {
      root = createRoot(container)
      root.render(<CreateWorkspaceDialog open onOpenChange={vi.fn()} />)
    })
    await flush()

    // Modal 走 Radix portal（挂到 document.body），所以查 document 而不是 container。
    const input = document.querySelector('#wb-newspace-name') as HTMLInputElement | null
    expect(input).toBeTruthy()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'Feishu work')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush(12, 30)

    expect(api.workspace.defaultRoot).toHaveBeenCalledWith('Feishu work')
    expect(document.body.textContent).toContain('/EverRoom/Workspace/feishu-work')
  })
})
