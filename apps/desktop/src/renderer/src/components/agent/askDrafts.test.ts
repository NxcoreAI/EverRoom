/** 批注草稿合批：技术指令与人话分开，单条不编号。 */
import { describe, expect, it } from 'vitest'

import { buildAskBatch, buildNoteCards, EMPTY_EXCERPT_PLACEHOLDER, type PendingAskDraft } from './askDrafts'

function draft(overrides: Partial<PendingAskDraft> = {}): PendingAskDraft {
  return {
    id: overrides.id ?? 'd1',
    workspaceId: overrides.workspaceId ?? 'ws-1',
    title: overrides.title,
    instruction: overrides.instruction,
    excerpt: overrides.excerpt,
    message: overrides.message ?? '我在 Word《方案.docx》第 4–6 块（正文「综上所述」）选中了这段内容：压缩成两句。',
    // 显式 undefined 也要覆盖默认值（note 退化链测试需要"真的没有 displayMessage"）。
    displayMessage: 'displayMessage' in overrides ? overrides.displayMessage : '关于 Word《方案.docx》第 5–7 段选中的内容：压缩成两句。',
    createdAt: overrides.createdAt ?? new Date(0).toISOString(),
  }
}

describe('buildAskBatch', () => {
  it('空数组 → null（发送按钮据此禁用）', () => {
    expect(buildAskBatch([])).toBeNull()
  })

  it('单条：技术指令与人话原样返回，不加编号', () => {
    const one = draft()
    expect(buildAskBatch([one])).toEqual({
      message: one.message,
      displayMessage: one.displayMessage,
    })
  })

  it('多条：合并成一条带编号的请求，并点名同一份文件；开场白不预设修改', () => {
    const batch = buildAskBatch([
      draft({ id: 'a', title: '方案.docx' }),
      draft({ id: 'b', title: '方案.docx', message: '我在 Word《方案.docx》第 9 块（表格）选中了这段内容：换列宽。', displayMessage: '关于第 10 段表格的内容：换列宽。' }),
    ])!
    expect(batch.message).toContain('我在《方案.docx》的 2 处内容上做了批注')
    expect(batch.message).toContain('请逐条看原话处理')
    expect(batch.message).toContain('1) 我在 Word《方案.docx》第 4–6 块')
    expect(batch.message).toContain('2) 我在 Word《方案.docx》第 9 块')
    expect(batch.message).not.toContain('修改意见')
    // 气泡侧：圈号 + 人话，技术指令不外泄
    expect(batch.displayMessage).toContain('我对这几处做了批注：① 关于 Word《方案.docx》第 5–7 段')
    expect(batch.displayMessage).toContain('② 关于第 10 段表格的内容')
    expect(batch.displayMessage).not.toContain('块（正文')
    expect(batch.displayMessage).not.toContain('word_agent')
  })

  it('跨文件：点名多份文件，不假装是一次单文件批注', () => {
    const batch = buildAskBatch([
      draft({ id: 'a', title: '方案.docx' }),
      draft({ id: 'b', title: '预算.xlsx', message: '我在 Excel《预算.xlsx》B2:C4 选中了这块内容：合计行加粗。', displayMessage: '关于 B2:C4 选中的内容：合计行加粗。' }),
    ])!
    expect(batch.message).toContain('我在《方案.docx》《预算.xlsx》的 2 处')
  })

  it('缺标题：退化成「打开的文件里」', () => {
    const batch = buildAskBatch([
      draft({ id: 'a', title: undefined }),
      draft({ id: 'b', title: undefined }),
    ])!
    expect(batch.message).toContain('我在打开的文件的 2 处')
  })

  it('超过 12 条时圈号退化成 (13)', () => {
    const many = Array.from({ length: 13 }, (_, index) => draft({ id: `d${index}` }))
    const batch = buildAskBatch(many)!
    expect(batch.displayMessage).toContain('⑫')
    expect(batch.displayMessage).toContain('(13)')
  })
})

describe('buildNoteCards', () => {
  it('有摘录：原样带上（折叠空白），note 取 instruction 优先', () => {
    const [card] = buildNoteCards([
      draft({ title: '方案.docx', instruction: '压缩成两句', excerpt: '综上所述……\n  项目达标。' }),
    ])
    expect(card!.excerpt).toBe('综上所述…… 项目达标。')
    expect(card!.note).toBe('压缩成两句')
    expect(card!.title).toBe('方案.docx')
  })

  it('摘录为 undefined（图片/形状等非文本选区）：给占位而不是空串，否则网关 minLength:1 会 422 拒掉整条消息', () => {
    const [card] = buildNoteCards([draft({ excerpt: undefined, instruction: '把这张图转灰度' })])
    expect(card!.excerpt).toBe(EMPTY_EXCERPT_PLACEHOLDER)
    expect(card!.excerpt.length).toBeGreaterThan(0)
  })

  it('摘录为纯空白：同样给占位', () => {
    const [card] = buildNoteCards([draft({ excerpt: '   \n\t ', instruction: '换个图' })])
    expect(card!.excerpt).toBe(EMPTY_EXCERPT_PLACEHOLDER)
  })

  it('无 instruction 时 note 退化到 displayMessage / message，标题空白则省略', () => {
    const [a, b] = buildNoteCards([
      draft({ instruction: undefined, displayMessage: '关于第 5 段：加粗' }),
      draft({ instruction: undefined, displayMessage: undefined, message: '技术指令', title: '   ' }),
    ])
    expect(a!.note).toBe('关于第 5 段：加粗')
    expect(b!.note).toBe('技术指令')
    expect(b).not.toHaveProperty('title')
  })
})
