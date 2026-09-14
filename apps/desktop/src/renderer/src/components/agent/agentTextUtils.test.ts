import { describe, expect, it } from 'vitest'
import { plainTextFromMarkdown } from './agentTextUtils'

describe('plainTextFromMarkdown', () => {
  it('strips headings, emphasis, links, and inline code', () => {
    expect(plainTextFromMarkdown('# 标题\n\n**加粗** 和 [链接文本](https://example.com) 与 `code`'))
      .toBe('标题 加粗 和 链接文本 与 code')
  })

  it('removes fenced code blocks entirely', () => {
    expect(plainTextFromMarkdown('先说结论\n```ts\nconst a = 1\n```\n再说一句'))
      .toBe('先说结论 再说一句')
  })

  it('drops image syntax but keeps alt text', () => {
    expect(plainTextFromMarkdown('![截图](https://example.com/a.png)')).toBe('截图')
  })

  it('collapses whitespace and caps length', () => {
    const long = '答 '.repeat(5000)
    const result = plainTextFromMarkdown(long, 100)
    expect(result.length).toBe(100)
    expect(result.includes('\n')).toBe(false)
  })

  it('keeps plain text as-is', () => {
    expect(plainTextFromMarkdown('普通回答文本。')).toBe('普通回答文本。')
  })
})
