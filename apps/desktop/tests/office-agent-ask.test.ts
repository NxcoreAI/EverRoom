/** 「AI 修改」转发：buildAgentAskMessage 文案组成 + wireSlidesAgentAsk 守卫与转发。 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp') } }))
vi.mock('../src/main/office/office-runtime', () => ({
  loadPreparedGenOfficeRuntime: vi.fn(),
}))

import {
  buildAgentAskDisplayMessage,
  buildAgentAskMessage,
  buildDocsAgentAskDisplayMessage,
  buildDocsAgentAskMessage,
  buildSheetsAgentAskDisplayMessage,
  buildSheetsAgentAskMessage,
  wireDocsAgentAsk,
  wireSheetsAgentAsk,
  wireSlidesAgentAsk,
  type DocsAgentAskPayload,
  type SheetsAgentAskPayload,
  type SlidesAgentAskPayload,
} from '../src/main/office/office-generation'

type AskHook = (
  wcId: number,
  op: SlidesAgentAskPayload,
) => Promise<{ ok: true } | { ok: false; error: string }>

type DocsAskHook = (
  wcId: number,
  op: DocsAgentAskPayload,
) => Promise<{ ok: true } | { ok: false; error: string }>

type SheetsAskHook = (
  wcId: number,
  op: SheetsAgentAskPayload,
) => Promise<{ ok: true } | { ok: false; error: string }>

let askHook: AskHook | null = null
let docsAskHook: DocsAskHook | null = null
let sheetsAskHook: SheetsAskHook | null = null
const registerSlidesIpc = vi.fn()
const registerDocsIpc = vi.fn()
const registerSheetsIpc = vi.fn()
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

  const docsTarget = {
    docs: {
      registerDocsIpc,
      setDocsAgentAskHook: vi.fn((fn: DocsAskHook) => {
        docsAskHook = fn
      }),
    },
  }
  wireDocsAgentAsk(docsTarget as never, {
    resolveInstance: (wcId: number) => resolveInstance(wcId),
    forward,
  })

  const sheetsTarget = {
    sheets: {
      registerSheetsIpc,
      setSheetsAgentAskHook: vi.fn((fn: SheetsAskHook) => {
        sheetsAskHook = fn
      }),
    },
  }
  wireSheetsAgentAsk(sheetsTarget as never, {
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
    expect(message).toContain('slides-builder')
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
      displayMessage: buildAgentAskDisplayMessage('季度汇报.pptx', OP),
    })
  })
})

const DOCS_OP: DocsAgentAskPayload = {
  instruction: '这段结论太绕，改成三句以内的结论句',
  fromBlockIndex: 4,
  toBlockIndex: 6,
  kind: 'text',
  excerpt: '综上所述，我们认为该方案在成本与可维护性上更具优势',
  blockType: 'docParagraph',
}

describe('buildDocsAgentAskMessage', () => {
  it('组成：标题、块索引区间、选区类型+摘要、指令、word 工具指引', () => {
    const message = buildDocsAgentAskMessage('方案.docx', DOCS_OP)
    expect(message).toContain('《方案.docx》')
    expect(message).toContain('第 4–6 块')
    expect(message).toContain('正文「综上所述')
    expect(message).toContain('改成三句以内的结论句')
    expect(message).toContain('word_agent_read')
    expect(message).toContain('word_agent_edit')
    expect(message).toContain('其他内容保持不动')
  })

  it('单块选区不写成区间；无摘要时不带空引号', () => {
    const message = buildDocsAgentAskMessage('t.docx', {
      instruction: '加粗',
      fromBlockIndex: 2,
      toBlockIndex: 2,
      kind: 'table',
    })
    expect(message).toContain('第 2 块')
    expect(message).toContain('（表格）')
    expect(message).not.toContain('–')
    expect(message).not.toContain('「」')
  })

  it('用户可见文案只留段号与人话，不出现块索引语法和工具名', () => {
    const display = buildDocsAgentAskDisplayMessage('方案.docx', DOCS_OP)
    expect(display).toContain('《方案.docx》第 5–7 段')
    expect(display).not.toContain('word_agent')
    expect(display).not.toContain('blockIndex')
    expect(display.endsWith('。')).toBe(true)
  })
})

describe('wireSlidesAgentAsk · 工作空间', () => {
  it('实例带 workspaceId 时一并转发（Room 已并入工作空间，渲染层按它定位标签）', async () => {
    resolveInstance.mockReturnValue({
      fileId: 'f1',
      title: '季度汇报.pptx',
      kind: 'slides',
      roomId: 'room-9',
      workspaceId: 'ws-9',
    })
    const result = await askHook!(9, OP)
    expect(result).toEqual({ ok: true })
    expect(forward).toHaveBeenCalledWith({
      roomId: 'room-9',
      workspaceId: 'ws-9',
      message: buildAgentAskMessage('季度汇报.pptx', OP),
      displayMessage: buildAgentAskDisplayMessage('季度汇报.pptx', OP),
    })
  })
})

describe('wireDocsAgentAsk', () => {
  it('先注册 docs IPC 再装 hook；重复 wire 幂等', () => {
    expect(registerDocsIpc).toHaveBeenCalledTimes(1)
    expect(docsAskHook).toBeTypeOf('function')

    const again = { docs: { registerDocsIpc, setDocsAgentAskHook: vi.fn() } }
    wireDocsAgentAsk(again as never, { resolveInstance, forward })
    expect(again.docs.setDocsAgentAskHook).not.toHaveBeenCalled()
  })

  it('runtime 没有该 hook（未重建 genoffice）→ 静默跳过', () => {
    // 幂等守卫已置位，这里只验证类型守卫不会抛错。
    expect(() => wireDocsAgentAsk({ docs: {} } as never, { resolveInstance, forward })).not.toThrow()
  })

  it('查无实例 → 报错不转发', async () => {
    resolveInstance.mockReturnValue(null)
    const result = await docsAskHook!(11, DOCS_OP)
    expect(result).toEqual({ ok: false, error: '未找到该 Word 对应的打开实例' })
    expect(forward).not.toHaveBeenCalled()
  })

  it('实例无 workspace → 报错引导，不转发', async () => {
    resolveInstance.mockReturnValue({ fileId: 'f2', title: 't.docx', kind: 'docx', roomId: null })
    const result = await docsAskHook!(11, DOCS_OP)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('未归属任何工作空间')
    expect(forward).not.toHaveBeenCalled()
  })

  it('命中 → 转发到所属工作空间，技术载荷与人话分开，带上文件名（批注清单点名）', async () => {
    resolveInstance.mockReturnValue({
      fileId: 'f2',
      title: '方案.docx',
      kind: 'docx',
      roomId: 'room-3',
      workspaceId: 'ws-3',
    })
    const result = await docsAskHook!(11, DOCS_OP)
    expect(result).toEqual({ ok: true })
    expect(forward).toHaveBeenCalledTimes(1)
    expect(forward).toHaveBeenCalledWith({
      roomId: 'room-3',
      workspaceId: 'ws-3',
      title: '方案.docx',
      fileId: 'f2',
      instruction: DOCS_OP.instruction,
      excerpt: DOCS_OP.excerpt,
      // 文档侧靠 anchor 重新高亮原文、面板展示「原文 + 批注」
      anchor: { fromBlockIndex: 4, toBlockIndex: 6, kind: 'text' },
      message: buildDocsAgentAskMessage('方案.docx', DOCS_OP),
      displayMessage: buildDocsAgentAskDisplayMessage('方案.docx', DOCS_OP),
    })
  })

  it('mode=queue → 事件带 mode，渲染层据此攒批注而不是立即发送', async () => {
    resolveInstance.mockReturnValue({
      fileId: 'f2',
      title: '方案.docx',
      kind: 'docx',
      roomId: 'room-3',
      workspaceId: 'ws-3',
    })
    await docsAskHook!(11, { ...DOCS_OP, mode: 'queue' })
    expect(forward).toHaveBeenCalledWith(expect.objectContaining({ mode: 'queue', title: '方案.docx' }))
  })
})

const SHEETS_OP: SheetsAgentAskPayload = {
  instruction: '合计行加粗并加底色',
  sheetId: 'sheet-01',
  sheetName: '预算',
  range: 'B2:C4',
  mode: 'queue',
}

describe('buildSheetsAgentAskMessage', () => {
  it('组成：标题、工作表+区域、sheetId、指令、sheets 工具指引', () => {
    const message = buildSheetsAgentAskMessage('预算.xlsx', SHEETS_OP)
    expect(message).toContain('《预算.xlsx》')
    expect(message).toContain('工作表「预算」 B2:C4')
    expect(message).toContain('sheetId=sheet-01')
    expect(message).toContain('合计行加粗并加底色')
    expect(message).toContain('sheets_agent_read')
    expect(message).toContain('sheets_agent_edit')
    expect(message).toContain('其他单元格保持不动')
  })

  it('缺 sheetName/range 时退化成「当前工作表」且不出现空区域', () => {
    const message = buildSheetsAgentAskMessage('t.xlsx', { instruction: '加粗' })
    expect(message).toContain('当前工作表 选中的内容')
    expect(message).not.toContain('sheetId=')
  })

  it('用户可见文案不出现 sheetId 与工具名', () => {
    const display = buildSheetsAgentAskDisplayMessage('预算.xlsx', SHEETS_OP)
    expect(display).toContain('工作表「预算」 B2:C4')
    expect(display).not.toContain('sheet-01')
    expect(display).not.toContain('sheets_agent')
  })
})

describe('wireSheetsAgentAsk', () => {
  it('先注册 sheets IPC 再装 hook；重复 wire 幂等', () => {
    expect(registerSheetsIpc).toHaveBeenCalledTimes(1)
    expect(sheetsAskHook).toBeTypeOf('function')

    const again = { sheets: { registerSheetsIpc, setSheetsAgentAskHook: vi.fn() } }
    wireSheetsAgentAsk(again as never, { resolveInstance, forward })
    expect(again.sheets.setSheetsAgentAskHook).not.toHaveBeenCalled()
  })

  it('查无实例 → 报错不转发', async () => {
    resolveInstance.mockReturnValue(null)
    const result = await sheetsAskHook!(21, SHEETS_OP)
    expect(result).toEqual({ ok: false, error: '未找到该 Excel 对应的打开实例' })
    expect(forward).not.toHaveBeenCalled()
  })

  it('实例无 workspace → 报错引导，不转发', async () => {
    resolveInstance.mockReturnValue({ fileId: 'f3', title: 't.xlsx', kind: 'xlsx', roomId: null })
    const result = await sheetsAskHook!(21, SHEETS_OP)
    expect(result.ok).toBe(false)
    expect(forward).not.toHaveBeenCalled()
  })

  it('命中 → 带上 mode=queue 与文件标题（批注清单点名用）', async () => {
    resolveInstance.mockReturnValue({
      fileId: 'f3',
      title: '预算.xlsx',
      kind: 'xlsx',
      roomId: 'room-4',
      workspaceId: 'ws-4',
    })
    const result = await sheetsAskHook!(21, SHEETS_OP)
    expect(result).toEqual({ ok: true })
    expect(forward).toHaveBeenCalledWith({
      roomId: 'room-4',
      workspaceId: 'ws-4',
      mode: 'queue',
      title: '预算.xlsx',
      fileId: 'f3',
      instruction: SHEETS_OP.instruction,
      anchor: { sheetId: 'sheet-01', sheetName: '预算', range: 'B2:C4' },
      message: buildSheetsAgentAskMessage('预算.xlsx', SHEETS_OP),
      displayMessage: buildSheetsAgentAskDisplayMessage('预算.xlsx', SHEETS_OP),
    })
  })
})
