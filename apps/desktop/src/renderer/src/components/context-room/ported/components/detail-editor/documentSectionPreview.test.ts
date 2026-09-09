import { describe, expect, it } from 'vitest'
import type { TiptapJsonContent } from '@nxcore/agent-contract'
import {
  SECTION_MIN_TEXT_CHARS,
  documentSectionBlocks,
  hashSectionContent,
  sectionPlainTextLength,
  serializeSectionMarkdown,
} from './documentSectionPreview'

function heading(blockId: string, level: number, text: string): TiptapJsonContent {
  return {
    type: 'heading',
    attrs: { level, id: blockId, 'data-toc-id': blockId },
    content: [{ type: 'text', text }],
  }
}

function paragraph(text: string): TiptapJsonContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

describe('documentSectionBlocks', () => {
  const content: TiptapJsonContent[] = [
    paragraph('引言段落'),
    heading('h-a', 2, '架构'),
    paragraph('架构第一段'),
    heading('h-a-1', 3, '网关'),
    paragraph('网关段落'),
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '列表项' }] }] }] },
    heading('h-b', 2, '迁移'),
    paragraph('迁移第一段'),
    heading('h-c', 1, '结语'),
    paragraph('结语段落'),
  ]

  it('cuts an h2 section at the next same-or-higher level heading (exclusive)', () => {
    const blocks = documentSectionBlocks(content, 'h-a')!
    expect(blocks.map((block) => block.type)).toEqual([
      'heading', 'paragraph', 'heading', 'paragraph', 'bulletList',
    ])
  })

  it('includes nested deeper headings and lists inside the section', () => {
    const blocks = documentSectionBlocks(content, 'h-a')!
    expect(blocks[2]).toMatchObject({ type: 'heading', attrs: { level: 3 } })
    expect(blocks[4]).toMatchObject({ type: 'bulletList' })
  })

  it('keeps the last section until the end of the document', () => {
    const blocks = documentSectionBlocks(content, 'h-c')!
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toMatchObject({ type: 'paragraph' })
  })

  it('honors h1 boundaries for h2 sections', () => {
    const blocks = documentSectionBlocks(content, 'h-b')!
    expect(blocks).toHaveLength(2)
  })

  it('returns null for unknown ids and empty content', () => {
    expect(documentSectionBlocks(content, 'missing')).toBeNull()
    expect(documentSectionBlocks([], 'h-a')).toBeNull()
    expect(documentSectionBlocks(undefined, 'h-a')).toBeNull()
    expect(documentSectionBlocks([paragraph('只有段落')], 'h-a')).toBeNull()
  })
})

describe('serializeSectionMarkdown', () => {
  it('serializes a section to markdown containing its text', () => {
    const markdown = serializeSectionMarkdown([
      heading('h-a', 2, '架构'),
      paragraph('架构第一段'),
    ])
    expect(markdown).toContain('架构第一段')
    expect(markdown).toMatch(/^##\s*架构/m)
  })
})

describe('hashSectionContent and sectionPlainTextLength', () => {
  it('produces a stable 64-char hex hash', async () => {
    const first = await hashSectionContent('同样内容')
    const second = await hashSectionContent('同样内容')
    const other = await hashSectionContent('不同内容')
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).toBe(second)
    expect(first).not.toBe(other)
  })

  it('measures plain-text length after stripping markdown marks', () => {
    expect(sectionPlainTextLength('')).toBe(0)
    expect(sectionPlainTextLength('## 标题')).toBe(2)
    expect(sectionPlainTextLength('[链接](https://x) 文本')).toBe(5)
    expect(sectionPlainTextLength(`\`\`\`\ncode block 忽略\n\`\`\``)).toBe(0)
    expect(SECTION_MIN_TEXT_CHARS).toBe(50)
  })
})
