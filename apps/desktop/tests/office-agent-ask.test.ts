/** 「AI 修改」转发：buildAgentAskMessage 文案组成 + wireSlidesAgentAsk 守卫与转发。 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp') } }))
vi.mock('../src/main/office/office-runtime', () => ({
  loadPreparedGenOfficeRuntime: vi.fn(),
}))

import {
  buildAgentAskMessage,
  wireSlidesAgentAsk,
  type SlidesAgentAskPayload,
} from '../src/main/office/office-generation'

type AskHook = (
  wcId: number,
  op: SlidesAgentAskPayload,
) => Promise<{ ok: true } | { ok: false; error: string }>

let askHook: AskHook | null = null
const registerSlidesIpc = vi.fn()
const forward = vi.fn()
let resolveInstance = vi.fn()

beforeAll(() => {
  const target = {
    slides: {
      registerSlidesIpc,
      setSlidesAgentAskHook: vi.fn((fn: AskHook) => {
        askHook = fn
      }),
    },
  }
  wireSlidesAgentAsk(target as never, {
    resolveInstance: (wcId: number) => resolveInstance(wcId),
    forward,
  })
})

beforeEach(() => {
  forward.mockClear()
  resolveInstance.mockReset()
})

const OP: SlidesAgentAskPayload = {
  instruction: '字号调大并改成主色',
  slideIndex: 2,
  targets: [
    { id: 'text-7', desc: { type: 'text', text: '季度营收概览\n第二行' } },
    { id: 'shape-1', desc: { type: 'shape' } },
  ],
}

describe('buildAgentAskMessage', () => {
  it('组成：标题、页码（slideIndex+1）、元素 id+类型+文本摘要、指令、工具指引', () => {
    const message = buildAgentAskMessage('季度汇报.pptx', OP)
    expect(message).toContain('《季度汇报.pptx》')
    expect(message).toContain('第 3 页')
    expect(message).toContain('text-7（文本框「季度营收概览」）')
    expect(message).toContain('shape-1（形状）')
    expect(message).toContain('字号调大并改成主色')
    expect(message).toContain('slides_draft(task=edit, fileId="active")')
    expect(message).toContain('slides-writer')
    expect(message).toContain('只改列出的元素')
  })

  it('长文本只取首行并截 24 字，未知类型沿用原名', () => {
    const long = '一'.repeat(30)
    const message = buildAgentAskMessage('t.pptx', {
      instruction: 'x',
      slideIndex: 0,
      targets: [{ id: 'n-1', desc: { type: 'weird', text: `${long}\ntail` } }],
    })
    expect(message).toContain(`n-1（weird「${'一'.repeat(24)}…」）`)
    expect(message).not.toContain('tail')
  })
})

describe('wireSlidesAgentAsk', () => {
  it('先注册 slides IPC 再装 hook；重复 wire 幂等', () => {
    expect(registerSlidesIpc).toHaveBeenCalledTimes(1)
    expect(askHook).toBeTypeOf('function')

    const again = { slides: { registerSlidesIpc, setSlidesAgentAskHook: vi.fn() } }
    wireSlidesAgentAsk(again as never, { resolveInstance, forward })
    expect(again.slides.setSlidesAgentAskHook).not.toHaveBeenCalled()
  })

  it('查无实例 → 报错不转发', async () => {
    resolveInstance.mockReturnValue(null)
    const result = await askHook!(9, OP)
    expect(result).toEqual({ ok: false, error: '未找到该 PPT 对应的打开实例' })
    expect(forward).not.toHaveBeenCalled()
  })

  it('实例无 roomId（非 Room 打开）→ 报错引导，不转发', async () => {
    resolveInstance.mockReturnValue({ fileId: 'f1', title: 't.pptx', kind: 'slides', roomId: null })
    const result = await askHook!(9, OP)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('未在 Room 中打开')
    expect(forward).not.toHaveBeenCalled()
  })

  it('命中 → 组装消息转发到 Room 频道', async () => {
    resolveInstance.mockReturnValue({ fileId: 'f1', title: '季度汇报.pptx', kind: 'slides', roomId: 'room-9' })
    const result = await askHook!(9, OP)
    expect(result).toEqual({ ok: true })
    expect(forward).toHaveBeenCalledTimes(1)
    expect(forward).toHaveBeenCalledWith({
      roomId: 'room-9',
      message: buildAgentAskMessage('季度汇报.pptx', OP),
    })
  })
})
