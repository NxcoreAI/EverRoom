import { describe, expect, it } from 'vitest'

import {
  markdownDocumentTitle,
  parseMarkdownDocument,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/markdownImport'
import { DOCUMENT_HEADING_LEVELS } from '../src/renderer/src/components/context-room/ported/components/detail-editor/documentHeadingLevels'

describe('Markdown document import', () => {
  it('supports every Markdown heading level without falling back to H1', () => {
    expect(DOCUMENT_HEADING_LEVELS).toEqual([1, 2, 3, 4, 5, 6])
    expect(parseMarkdownDocument('### 2. 章节\n\n#### 2.1 小节').content).toEqual([
      expect.objectContaining({ type: 'heading', attrs: { level: 3 } }),
      expect.objectContaining({ type: 'heading', attrs: { level: 4 } }),
    ])
  })

  it('uses the local file name as the default document title', () => {
    expect(markdownDocumentTitle('项目说明.md')).toBe('项目说明')
    expect(markdownDocumentTitle('release-notes.MARKDOWN')).toBe('release-notes')
    expect(markdownDocumentTitle('.md')).toBe('无标题文档')
  })

  it('parses common Markdown and task lists into Tiptap JSON', () => {
    expect(parseMarkdownDocument('# 标题\n\n**重点**\n\n- [x] 已完成')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: '标题' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '重点', marks: [{ type: 'bold' }] }],
        },
        {
          type: 'taskList',
          content: [{
            type: 'taskItem',
            attrs: { checked: true },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '已完成' }] }],
          }],
        },
      ],
    })
  })

  it('preserves Markdown tables and images as rich document nodes', () => {
    const parsed = parseMarkdownDocument(
      '| 名称 | 值 |\n| --- | --- |\n| A | 1 |\n\n![预览](data:image/png;base64,ZmFrZQ==)',
    )
    expect(parsed.content).toHaveLength(2)
    expect(parsed.content?.[0]).toMatchObject({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '名称' }] }] },
            { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '值' }] }] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }] },
          ],
        },
      ],
    })
    expect(parsed.content?.[1]).toMatchObject({
      type: 'image',
      attrs: { src: 'data:image/png;base64,ZmFrZQ==', alt: '预览', title: null },
    })
  })

  it('normalizes an empty Markdown file to an editable paragraph', () => {
    expect(parseMarkdownDocument('')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    })
  })
})
