/** 批注草稿合批：技术指令与人话分开，单条不编号。 */
import { describe, expect, it } from 'vitest'

import { buildAskBatch, type PendingAskDraft } from './askDrafts'

function draft(overrides: Partial<PendingAskDraft> = {}): PendingAskDraft {
  return {
    id: overrides.id ?? 'd1',
    workspaceId: overrides.workspaceId ?? 'ws-1',
    title: 'title' in overrides ? overrides.title : '方案.docx',
    message: overrides.message ?? '我在 Word《方案.docx》第 4–6 块（正文「综上所述」）选中了这段内容：压缩成两句。',
    displayMessage: overrides.displayMessage ?? '关于 Word《方案.docx》第 5–7 段选中的内容：压缩成两句。',
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
      draft({ id: 'a' }),
      draft({ id: 'b', message: '我在 Word《方案.docx》第 9 块（表格）选中了这段内容：换列宽。', displayMessage: '关于第 10 段表格的内容：换列宽。' }),
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
