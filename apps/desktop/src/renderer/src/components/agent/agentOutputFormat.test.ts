import { describe, expect, it } from 'vitest'

import { formatAgentOutput } from './agentOutputFormat'

describe('formatAgentOutput', () => {
  it('removes Markdown controls while preserving readable Chinese paragraphs', () => {
    expect(formatAgentOutput('## **结果**\n\n请打开 `Context Room`，查看__新文档__。')).toEqual([
      { type: 'paragraph', text: '结果' },
      { type: 'paragraph', text: '请打开 Context Room，查看新文档。' },
    ])
  })

  it('normalizes common ordered and unordered list markers', () => {
    expect(formatAgentOutput('- 第一项\n* **第二项**\n\n1. 开始\n2、完成')).toEqual([
      { type: 'list', ordered: false, items: ['第一项', '第二项'] },
      { type: 'list', ordered: true, items: ['开始', '完成'] },
    ])
  })

  it('drops code fences without discarding their content', () => {
    expect(formatAgentOutput('```text\n普通内容\n```')).toEqual([
      { type: 'paragraph', text: '普通内容' },
    ])
  })
})
