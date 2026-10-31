import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 主进程主动打开预览后必须通知渲染端。
 *
 * 背景：应用内所有 Office 预览实例的可见性都由渲染端驱动（标签页 → 上报矩形 →
 * setActiveInstance）。主进程单方面 open() 只会得到一个 setVisible(false) 的
 * WebContentsView，也就是排版面板点 👁 时用户看到的「完全没反应」。
 */
const { windows, sent } = vi.hoisted(() => ({
  windows: [] as Array<{
    destroyed: boolean
    isDestroyed: () => boolean
    webContents: { send: (channel: string, payload: unknown) => void }
  }>,
  sent: [] as Array<{ channel: string; payload: unknown }>,
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => windows,
  },
}))

import { notifyPreviewRequested, previewRequestFromOpenResult } from '../src/main/office/preview-request'
import { OFFICE_PREVIEW_REQUEST_CHANNEL } from '../src/shared/sources'

function makeWindow(destroyed = false) {
  const entry = {
    destroyed,
    isDestroyed: () => entry.destroyed,
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload })
      },
    },
  }
  windows.push(entry)
  return entry
}

beforeEach(() => {
  windows.length = 0
  sent.length = 0
})

describe('notifyPreviewRequested', () => {
  it('把实例 id / 标题 / 形态发给主窗口渲染端（通道与 payload 都要对）', () => {
    makeWindow()
    const ok = notifyPreviewRequested({ instanceId: 'file-1', title: '模版.docx', kind: 'docx' })
    expect(ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.channel).toBe(OFFICE_PREVIEW_REQUEST_CHANNEL)
    expect(sent[0]?.payload).toEqual({ instanceId: 'file-1', title: '模版.docx', kind: 'docx' })
  })

  it('跳过已销毁窗口，投给第一个存活窗口', () => {
    makeWindow(true)
    const alive = makeWindow()
    expect(notifyPreviewRequested({ instanceId: 'file-2', title: 'a.pdf', kind: 'pdf' })).toBe(true)
    expect(sent).toHaveLength(1)
    expect(alive.destroyed).toBe(false)
  })

  it('没有存活窗口时返回 false，不抛错（文档本身已经建好，不该当失败）', () => {
    expect(notifyPreviewRequested({ instanceId: 'file-3', title: 'b.docx', kind: 'docx' })).toBe(false)
    expect(sent).toHaveLength(0)
  })
})

describe('previewRequestFromOpenResult', () => {
  it('Office 实例齐全 → 生成通知载荷', () => {
    expect(
      previewRequestFromOpenResult({
        openedWith: 'office',
        instanceId: 'file-9',
        kind: 'docx',
        title: '论文模版.docx',
      }),
    ).toEqual({ instanceId: 'file-9', title: '论文模版.docx', kind: 'docx' })
  })

  it('交给系统应用打开（external）→ 不发通知，避免开一个空标签', () => {
    expect(previewRequestFromOpenResult({ openedWith: 'external' })).toBeNull()
  })

  it('缺字段 → 不发通知（宁可不显示，也不开一个点进去什么都没有的标签）', () => {
    expect(previewRequestFromOpenResult({ openedWith: 'office', instanceId: 'file-9', kind: 'docx' })).toBeNull()
    expect(previewRequestFromOpenResult({ openedWith: 'office', instanceId: 'file-9', title: 'x.docx' })).toBeNull()
  })
})
