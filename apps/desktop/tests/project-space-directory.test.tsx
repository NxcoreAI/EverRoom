// @vitest-environment happy-dom
/**
 * 项目空间目录化（P0）渲染层回归：
 * 1) 概览「空间目录」卡：路���来自 `nxcore.workspace.layout`，健康异常有提示，「修复」调网关并 toast；
 * 2) 新建弹窗：不选目录时显示默认落点 `<dataDir>/Workspace/<slug>` 预览（来自 `workspace.defaultRoot`）。
 *
 * 与 tests/workbench-workspace-tools.test.tsx 同款 happy-dom + 手动 act/createRoot 写法。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSpaceLayout, AgentWorkspace } from '@nxcore/agent-contract'

import { CreateWorkspaceDialog } from '../src/renderer/src/workbench/workspace/CreateWorkspaceDialog'
import { SpaceDirectoryCard } from '../src/renderer/src/workbench/workspace/SpaceDirectoryCard'

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
        slug: name.trim().toLowerCase().replace(/\s+/gu, '-'),
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

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  container.remove()
  ;(window as unknown as { nxcore?: unknown }).nxcore = undefined
  vi.restoreAllMocks()
})

describe('SpaceDirectoryCard', () => {
  it('renders the space root and reveals it in the file browser', async () => {
    const api = installNxcore()
    const onToast = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(<SpaceDirectoryCard workspace={WORKSPACE} onToast={onToast} />)
    })
    await flush()

    expect(container.textContent).toContain(ROOT)
    const reveal = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('在访达中显示'))
    expect(reveal).toBeTruthy()
    await act(async () => { reveal?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    expect(api.workspace.reveal).toHaveBeenCalledWith(ROOT)
    expect(onToast).not.toHaveBeenCalled()
  })

  it('surfaces missing role directories and repairs them', async () => {
    const api = installNxcore({
      layout: async () => layoutOf({ missingDirectories: ['Memory'] }),
      repair: async () => ({ spaceId: WORKSPACE.id, createdDirectories: ['Memory'], createdMarker: false, readonly: false }),
    })
    const onToast = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(<SpaceDirectoryCard workspace={WORKSPACE} onToast={onToast} />)
    })
    await flush()

    expect(container.textContent).toContain('Memory')

    const repair = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('修复'))
    await act(async () => { repair?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    expect(api.workspace.repair).toHaveBeenCalledWith(WORKSPACE.id)
    expect(onToast).toHaveBeenCalledWith('已补回 1 个目录')
    // 修完重新拉一次健康状态。
    expect(api.workspace.layout).toHaveBeenCalledTimes(2)
  })

  it('syncs the directory with the library and reports what changed', async () => {
    const api = installNxcore({
      reconcileLibrary: async () => ({
        spaceId: WORKSPACE.id,
        scanned: 3,
        added: ['inbox/x.md'],
        missing: [],
        restored: [],
        failed: [],
      }),
    })
    const onToast = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(<SpaceDirectoryCard workspace={WORKSPACE} onToast={onToast} />)
    })
    await flush()

    const sync = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('同步目录'))
    await act(async () => { sync?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    expect(api.workspace.reconcileLibrary).toHaveBeenCalledWith(WORKSPACE.id)
    expect(onToast).toHaveBeenCalledWith('已同步目录：新增 1')
  })

  it('shows cache usage and clears it on demand', async () => {
    const api = installNxcore()
    const onToast = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(<SpaceDirectoryCard workspace={WORKSPACE} onToast={onToast} />)
    })
    await flush()

    expect(container.textContent).toContain('缓存 1.5 MB')
    const clear = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('清理缓存'))
    await act(async () => { clear?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(api.workspace.gcCache).toHaveBeenCalledWith(WORKSPACE.id)
    expect(onToast).toHaveBeenCalledWith('已清理 2 KB 缓存')
  })

  it('lists temp files read-only and can clear them from the modal', async () => {
    const api = installNxcore()
    const onToast = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(<SpaceDirectoryCard workspace={WORKSPACE} onToast={onToast} />)
    })
    await flush()

    // 缓存行里给出「临时文件 N」入口。
    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('临时文件'))
    expect(entry).toBeTruthy()
    expect(entry?.textContent).toContain('2')

    await act(async () => { entry?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    expect(api.workspace.scratchFiles).toHaveBeenCalledWith(WORKSPACE.id)
    // 只读清单：内容渲染在 Modal（portal 到 body），带大小与相对路径。
    expect(document.body.textContent).toContain('thesis/run-1/transcript.txt')
    expect(document.body.textContent).toContain('screenshot.jpg')
    expect(document.body.textContent).toContain('2 个文件')
    expect(document.body.textContent).toContain('2 KB')
    // 只读：没有任何写库/删除入口（只有「清理全部」走缓存 GC）。
    expect(document.body.textContent).toContain('不进资料库')

    const clear = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('清理全部'))
    expect(clear).toBeTruthy()
    await act(async () => { clear?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    expect(api.workspace.gcCache).toHaveBeenCalledWith(WORKSPACE.id)
    expect(onToast).toHaveBeenCalledWith('已清理 1 个临时文件')
    // 清理后重新拉清单。
    expect(api.workspace.scratchFiles).toHaveBeenCalledTimes(2)
  })

  it('offers relocation when the directory went missing', async () => {
    const api = installNxcore({ layout: async () => layoutOf({ exists: false, markerPresent: false }) })
    const onToast = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(<SpaceDirectoryCard workspace={WORKSPACE} onToast={onToast} />)
    })
    await flush()

    expect(container.textContent).toContain('目录不在原位')

    const relocate = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('重新定位'))
    await act(async () => { relocate?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    // 没有选目录就什么都不做（用户取消了原生选择框）。
    expect(api.workspace.pickDirectory).toHaveBeenCalled()
    expect(api.workspace.relocate).not.toHaveBeenCalled()
  })

  it('shows the unbound state when the space has no directory', async () => {
    installNxcore()
    await act(async () => {
      root = createRoot(container)
      root.render(<SpaceDirectoryCard workspace={{ ...WORKSPACE, path: null }} onToast={vi.fn()} />)
    })
    await flush()
    expect(container.textContent).toContain('还没有绑定目录')
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
