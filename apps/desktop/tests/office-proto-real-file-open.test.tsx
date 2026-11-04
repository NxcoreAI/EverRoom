// @vitest-environment happy-dom
/**
 * 回归：文件区（最近 / 所有文件）点击真实 pptx 后必须真的把文件库预览显示出来。
 *
 * 背景（迁移后实机 bug）：新 UI 的文件列表点真实文件时，旧适配只调了
 * files.openOriginal 就返回——主进程把 WebContentsView 建好但保持 hidden，
 * 新 UI 里又没有任何代码调 office.setActiveInstance / setWorkspaceBounds，
 * 于是用户点 ppt 看起来「完全没反应」。这里用 happy-dom 渲染真实组件树，
 * mock 文件库桥，断言「点文件 → 开标签页 → 打开原件 → 激活实例 → 上报矩形」整条链。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OfficeProto } from '../src/renderer/src/office-proto/OfficeProto'
import type { FileCatalogDto } from '../src/shared/ingest'

// React 18 的 act() 需要显式声明测试环境，否则每次状态更新都会打 warning。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONTENT_HASH = 'a'.repeat(64)

const catalog: FileCatalogDto = {
  id: 'file-real-pptx',
  originalName: '季度汇报.pptx',
  displayName: null,
  sharedTitle: '季度汇报',
  sourceKind: 'manual-upload',
  sourceLabel: '本地上传',
  relativePath: null,
  provider: null,
  bytes: 2_400_000,
  dataType: null,
  agentCategory: null,
  summary: null,
  tags: [],
  processingState: 'ready',
  clusterId: null,
  contentHash: CONTENT_HASH,
  currentVersionId: null,
  parsed: true,
  updatedAt: new Date().toISOString(),
}

const RECT = {
  x: 120, y: 96, width: 960, height: 640,
  top: 96, left: 120, right: 1080, bottom: 736,
  toJSON: () => ({}),
} as DOMRect

function bridgeMocks() {
  return {
    list: vi.fn().mockResolvedValue({ items: [catalog], total: 1 }),
    openOriginal: vi.fn().mockResolvedValue({
      openedWith: 'office' as const,
      instanceId: catalog.id,
      kind: 'slides' as const,
      title: catalog.originalName,
    }),
    setActiveInstance: vi.fn().mockResolvedValue(true),
    closeInstance: vi.fn().mockResolvedValue(true),
    setWorkspaceBounds: vi.fn(),
    desktopOpen: vi.fn().mockResolvedValue({ ok: true }),
    desktopActivate: vi.fn().mockResolvedValue(true),
    desktopClose: vi.fn().mockResolvedValue(true),
    desktopSendBounds: vi.fn(),
    // 停靠栏 Agent 面：必须打到真实 preload 桥（window.nxcore.agent），不能再有 mock 兜底。
    agentListSessions: vi.fn().mockResolvedValue([]),
    agentOnEvent: vi.fn(() => () => {}),
    agentUnsubscribe: vi.fn().mockResolvedValue(undefined),
  }
}

let mocks: ReturnType<typeof bridgeMocks>
let container: HTMLDivElement
let root: Root

/** 推进若干轮微任务 + happy-dom 的两帧 rAF，让 open/effect/report 链路跑完。 */
async function flush(rounds = 24): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
}

beforeEach(() => {
  mocks = bridgeMocks()
  ;(window as unknown as { nxcore: unknown }).nxcore = {
    platform: 'darwin',
    files: { list: mocks.list, openOriginal: mocks.openOriginal },
    agent: {
      listSessions: mocks.agentListSessions,
      onEvent: mocks.agentOnEvent,
      unsubscribe: mocks.agentUnsubscribe,
    },
    office: {
      setActiveInstance: mocks.setActiveInstance,
      closeInstance: mocks.closeInstance,
      setWorkspaceBounds: mocks.setWorkspaceBounds,
    },
  }
  ;(window as unknown as { desktop: unknown }).desktop = {
    platform: 'darwin',
    versions: { electron: '40.0.0', chrome: '140.0.0' },
    office: {
      open: mocks.desktopOpen,
      activate: mocks.desktopActivate,
      close: mocks.desktopClose,
      sendBounds: mocks.desktopSendBounds,
    },
  }
  // happy-dom 没有布局：给所有元素一个稳定的非零矩形，让矩形上报链路可断言。
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(RECT)
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    media: '',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as typeof window.matchMedia

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
  delete (window as unknown as { nxcore?: unknown }).nxcore
  delete (window as unknown as { desktop?: unknown }).desktop
})

describe('文件区打开真实 pptx', () => {
  it('点击真实文件 → 建标签页 → 打开原件 → 激活实例并上报非零矩形', async () => {
    await act(async () => { root.render(<OfficeProto />) })
    await flush()

    const row = container.querySelector<HTMLElement>('.op-file-row')
    expect(row, '最近文件列表应渲染出真实文件行').not.toBeNull()
    expect(row!.textContent).toContain('季度汇报.pptx')

    await act(async () => { row!.click() })
    await flush()

    // 1) 标签页真的建出来了（旧实现这里什么都不会发生）
    expect(container.querySelector('.op-tab-name')?.textContent).toBe('季度汇报.pptx')
    // 2) 打开文件库原件（可编辑）
    expect(mocks.openOriginal).toHaveBeenCalledWith(
      catalog.id,
      catalog.originalName,
      CONTENT_HASH,
      { editable: true },
    )
    // 3) 激活原生预览实例——缺了这一步视图就一直是 hidden
    expect(mocks.setActiveInstance).toHaveBeenCalledWith(catalog.id)
    // 4) 上报宿主矩形，主进程才会把视图显示到标签页内容区
    const bounds = mocks.setWorkspaceBounds.mock.calls.map(([value]) => value as typeof RECT)
    expect(bounds.some((value) => value.width > 0 && value.height > 0)).toBe(true)

    // 5) 停靠栏 Agent 面板挂在外壳层（与 md 路径同一个 SideDock），并且
    //    直接吃 window.nxcore.agent 真实桥——回归：曾装在无 preload 的 iframe 里
    //    落到脚本化 mock，无论输入什么都回同一段固定文案。
    expect(container.querySelector('.op-dock .agent-panel')).not.toBeNull()
    // 会话分区键 = 文件稳定 id（不是会变的文件名）：改名/超长都不会丢历史。
    expect(mocks.agentListSessions).toHaveBeenCalledWith(`real:${catalog.id}`)
  })

  it('原型 mock 文件仍走 window.desktop 桥（真实文件接入不改动 mock 路径）', async () => {
    await act(async () => { root.render(<OfficeProto />) })
    await flush()

    const tile = Array.from(container.querySelectorAll<HTMLElement>('.op-create-tile'))
      .find((element) => element.textContent?.includes('演示'))
    expect(tile).not.toBeNull()
    await act(async () => { tile!.click() })
    await flush()

    expect(mocks.desktopOpen).toHaveBeenCalledTimes(1)
    const request = mocks.desktopOpen.mock.calls[0]![0] as { fileId: string; spec: { kind: string } }
    expect(request.fileId.startsWith('f-blank-pptx-')).toBe(true)
    expect(request.spec.kind).toBe('pptx')
    expect(mocks.desktopActivate).toHaveBeenCalledWith(request.fileId)
    expect(mocks.desktopSendBounds.mock.calls.some(([value]) => (value as typeof RECT).width > 0)).toBe(true)
    // 文件库预览这条链不应被 mock 打开触发
    expect(mocks.openOriginal).not.toHaveBeenCalled()
  })

  it('关闭真实文件标签页时销毁文件库预览实例', async () => {
    await act(async () => { root.render(<OfficeProto />) })
    await flush()
    await act(async () => { container.querySelector<HTMLElement>('.op-file-row')!.click() })
    await flush()

    const close = container.querySelector<HTMLElement>('.op-tab-close')
    expect(close).not.toBeNull()
    await act(async () => { close!.click() })
    await flush()

    expect(mocks.closeInstance).toHaveBeenCalledWith(catalog.id)
    expect(container.querySelector('.op-tab-name')).toBeNull()
  })
})
