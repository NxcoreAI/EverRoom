// @vitest-environment happy-dom
/**
 * 模版预览标签「点不动」回归：NativeEditorHost 打开成功且宿主可见时，
 * 必须调用 office.setActiveInstance（否则 WebContentsView 永远 setVisible(false)，
 * 用户看到标签却点不出内容——2026-11-09 外文翻译模版预览现场）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NativeEditorHost } from '../src/renderer/src/office-proto/NativeEditorHost'
import type { FileCatalogDto } from '../src/shared/ingest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const setActiveInstance = vi.fn(async () => true)
const setWorkspaceBounds = vi.fn()
const openOriginal = vi.fn(async () => ({
  openedWith: 'office',
  instanceId: 'file-template-1',
  kind: 'docx',
  title: '模版.doc',
}))

const catalog = {
  id: 'file-template-1',
  originalName: '附件4-6-1：毕业设计（论文）外文翻译 (1).doc',
  displayName: null,
  contentHash: 'a'.repeat(64),
  bytes: 23670,
  createdAt: '2026-11-06T12:00:00.000Z',
  updatedAt: '2026-11-09T06:00:00.000Z',
  workspaceId: 'ws-1',
} as unknown as FileCatalogDto

let container: HTMLDivElement
let root: Root | null = null
// happy-dom 的 raf 是同步派发？这里手动兜一层可控的帧回调队列。
const rafCallbacks: FrameRequestCallback[] = []

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  // happy-dom 的 getBoundingClientRect 全 0：给宿主一个非零尺寸的近似实现
  // （componentReadRect 走 DOMRect；只要 width/height > 0 即可通过 paintable）。
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    return new DOMRect(959, 95, 466, 778)
  }
  Object.defineProperty(window, 'nxcore', {
    configurable: true,
    value: {
      files: { openOriginal },
      office: { setActiveInstance, setWorkspaceBounds },
    },
  })
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: { diagnostics: { log: () => undefined } },
  })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1080 })
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafCallbacks.push(cb)
    return rafCallbacks.length
  }) as typeof requestAnimationFrame
  document.body.appendChild(container)
})

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  container.remove()
  rafCallbacks.length = 0
})

async function flushFrames(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    const batch = rafCallbacks.splice(0)
    await act(async () => { batch.forEach((cb) => cb(0)) })
  }
}

describe('NativeEditorHost 激活链（模版预览回归）', () => {
  it('打开成功且宿主可见 → 调 setActiveInstance(实例id) 并上报矩形', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <NativeEditorHost
          fileId="real:file-template-1"
          title="附件4-6-1：毕业设计（论文）外文翻译 (1).doc"
          realCatalog={catalog}
        />,
      )
    })
    await flushFrames()
    expect(openOriginal).toHaveBeenCalledWith(
      'file-template-1',
      '附件4-6-1：毕业设计（论文）外文翻译 (1).doc',
      'a'.repeat(64),
      { editable: true },
    )
    expect(setActiveInstance).toHaveBeenCalledWith('file-template-1')
    expect(setWorkspaceBounds).toHaveBeenCalledWith(
      expect.objectContaining({ width: 466, height: 778 }),
    )
  })

  it('激活只发一次（矩形去重），重复上报不重复激活', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <NativeEditorHost
          fileId="real:file-template-1"
          title="附件4-6-1：毕业设计（论文）外文翻译 (1).doc"
          realCatalog={catalog}
        />,
      )
    })
    await flushFrames(8)
    expect(setActiveInstance).toHaveBeenCalledTimes(1)
  })
})

describe('NativeEditorHost 浮层探测（透明浮层不锁激活）', () => {
  it('aria-modal 弹窗退场后 opacity:0 → 仍应激活（2026-11-09 模版预览锁死回归）', async () => {
    // 模拟 AgentAuthChallengeCard 退场终态：aria-modal=true + opacity:0 + visibility:visible
    const stale = document.createElement('div')
    stale.setAttribute('role', 'dialog')
    stale.setAttribute('aria-modal', 'true')
    stale.className = 'stale-auth-dialog'
    Object.defineProperty(stale, 'getBoundingClientRect', {
      value: () => new DOMRect(0, 0, 1920, 1080),
    })
    const style = document.createElement('style')
    style.textContent = '.stale-auth-dialog { opacity: 0; visibility: visible; }'
    document.head.appendChild(style)
    document.body.appendChild(stale)
    try {
      await act(async () => {
        root = createRoot(container)
        root.render(
          <NativeEditorHost
            fileId="real:file-template-1"
            title="附件4-6-1：毕业设计（论文）外文翻译 (1).doc"
            realCatalog={catalog}
          />,
        )
      })
      await flushFrames()
      expect(setActiveInstance).toHaveBeenCalledWith('file-template-1')
    } finally {
      stale.remove()
      style.remove()
    }
  })
})

describe('NativeEditorHost 在途打开竞态（2026-11-09 模版预览锁死回归）', () => {
  it('openOriginal 未返回时 effect 重跑 → 第二轮 open 早退 ok → ready → activate 仍须等到 instanceId 落地后才激活', async () => {
    // 复现现场时序：openOriginal 飞行中，realCatalog 对象身份变化触发 effect 重跑
    let resolveOpen: ((value: { openedWith: string; instanceId: string; kind: string; title: string }) => void) | null = null
    openOriginal.mockImplementation(() => new Promise((resolve) => { resolveOpen = resolve }))
    await act(async () => {
      root = createRoot(container)
      root.render(
        <NativeEditorHost
          fileId="real:file-template-1"
          title="附件4-6-1：毕业设计（论文）外文翻译 (1).doc"
          realCatalog={catalog}
        />,
      )
    })
    // 等第一轮 open 已经在飞（微任务排空但 openOriginal 未 resolve）
    await act(async () => { await Promise.resolve() })
    // bubble.openFile 替换同 id 文件 → 新对象；title（file.name 的规范化差异）
    // 变化会让 open 回调身份失效 → open effect 重跑 → 第二轮 open() 命中
    // inFlightKey 早退【立即】ok → setStatus('ready')（现场 07:32:11.610）。
    const catalogCopy = { ...catalog, originalName: '附件4-6-1：毕业设计（论文）外文翻译 (1).doc ' } as unknown as FileCatalogDto
    await act(async () => {
      root?.render(
        <NativeEditorHost
          fileId="real:file-template-1"
          title="附件4-6-1：毕业设计（论文）外文翻译 (1).doc "
          realCatalog={catalogCopy}
        />,
      )
    })
    // flush 帧：report() 跑 activate 时 openOriginal 仍在飞、instanceId 未落地。
    // 【修复前】静默跳过且 report 不再触发（矩形未变）→ 永远不激活；
    // 【修复后】activate 挂在在途 promise 上，resolve 后自动完成激活。
    await flushFrames(3)
    expect(setActiveInstance).not.toHaveBeenCalled()
    // openOriginal 返回 → instanceId 落地 → activate 的 await 恢复
    await act(async () => { resolveOpen?.({ openedWith: 'office', instanceId: 'file-template-1', kind: 'docx', title: '模版' }) })
    // 第二轮 open 的 await 恢复 → setStatus('ready') → bounds effect → 双 raf → report
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await flushFrames(4)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(setActiveInstance).toHaveBeenCalledWith('file-template-1')
  })
})
