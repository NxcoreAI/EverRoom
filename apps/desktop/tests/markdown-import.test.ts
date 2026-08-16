import { describe, expect, it } from 'vitest'

import {
  markdownDocumentTitle,
  parseMarkdownDocument,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/markdownImport'

describe('Markdown document import', () => {
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

  it('normalizes an empty Markdown file to an editable paragraph', () => {
    expect(parseMarkdownDocument('')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    })
  })
})
