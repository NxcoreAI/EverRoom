// @vitest-environment happy-dom
/**
 * 工作空间气泡窗状态机回归测试。
 *
 * 重点：聊天区右上角「资料与文件」入口打开的浏览态（activeFileId=null）与文档态之间的切换：
 * ① 入口打开浏览态；② 从列表打开文件进文档态；③ 关掉最后一个文件回到浏览态而不是收起面板；
 * ④ 目录按钮可随时切回浏览态；⑤ 显式关闭才真正收起。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { OfficeFile } from '../src/renderer/src/office-proto/data'
import { useWorkspaceBubble } from '../src/renderer/src/workbench/workspace/useBubble'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type BubbleApi = ReturnType<typeof useWorkspaceBubble>

function file(id: string): OfficeFile {
  return {
    id,
    name: `${id}.docx`,
    kind: 'docx',
    roomId: null,
    updatedLabel: '刚刚',
    sizeLabel: '1 KB',
    memoryCount: 0,
    content: { type: 'md', source: '' },
  }
}

let container: HTMLDivElement
let root: Root | null = null
let api: BubbleApi | null = null

function Probe({ capture }: { capture: (value: BubbleApi) => void }) {
  const bubble = useWorkspaceBubble('tab-test')
  capture(bubble)
  return <span data-mode={bubble.bubble.mode} data-active={bubble.bubble.activeFileId ?? 'browse'} />
}

async function renderProbe(): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<Probe capture={(value) => { api = value }} />)
  })
}

function stateText(): string {
  const el = container.querySelector('[data-mode]')
  return `${el?.getAttribute('data-mode')}:${el?.getAttribute('data-active')}`
}

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  api = null
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container.remove()
  delete (window as unknown as { nxcore?: unknown }).nxcore
})

describe('气泡窗浏览态 / 文档态', () => {
  it('初始收起', async () => {
    await renderProbe()
    expect(stateText()).toBe('closed:browse')
  })

  it('「资料与文件」入口打开浏览态，不挂任何文档', async () => {
    await renderProbe()
    await act(async () => api?.openBrowser())
    expect(api?.bubble.mode).toBe('open')
    expect(api?.bubble.activeFileId).toBeNull()
    expect(stateText()).toBe('open:browse')
  })

  it('从浏览列表打开文件切到文档态，文件夹按钮切回浏览态', async () => {
    await renderProbe()
    await act(async () => api?.openBrowser())
    await act(async () => api?.openFile(file('f1')))
    expect(api?.bubble.files.map((item) => item.id)).toEqual(['f1'])
    expect(api?.bubble.activeFileId).toBe('f1')

    await act(async () => api?.openBrowser())
    expect(api?.bubble.activeFileId).toBeNull()
    // 文件标签保留，只是不激活。
    expect(api?.bubble.files.map((item) => item.id)).toEqual(['f1'])

    await act(async () => api?.activateFile('f1'))
    expect(api?.bubble.activeFileId).toBe('f1')
  })

  it('关掉最后一个文件回到浏览态（面板不收起）', async () => {
    await renderProbe()
    await act(async () => api?.openFile(file('f1')))
    await act(async () => { await api?.closeFile('f1') })
    expect(api?.bubble.files).toHaveLength(0)
    expect(api?.bubble.mode).toBe('open')
    expect(api?.bubble.activeFileId).toBeNull()
  })

  it('显式关闭：退场动画期间保留内容，动画结束才收起并清空文件', async () => {
    await renderProbe()
    await act(async () => api?.openFile(file('f1')))
    await act(async () => { await api?.closeAll() })
    // 退场中：面板仍挂载、内容保留，避免关闭瞬间文档变成空列表。
    expect(api?.visible).toBe(true)
    expect(api?.exitKind).toBe('close')
    expect(api?.bubble.files).toHaveLength(1)

    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 280) }) })
    expect(api?.visible).toBe(false)
    expect(api?.exitKind).toBeNull()
    expect(api?.bubble.mode).toBe('closed')
    expect(api?.bubble.files).toHaveLength(0)
  })
})
