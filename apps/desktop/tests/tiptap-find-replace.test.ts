import { describe, expect, it } from 'vitest'

import { findMatchesInText, type TextIndex } from '../src/renderer/src/components/context-room/ported/components/detail-editor/TiptapFindReplaceExtension'

function index(text: string, segmentTexts: string[], startFrom = 10): TextIndex {
  const segments = segmentTexts.map((segmentText) => {
    const from = startFrom + startFrom % 2 // 任意错开，验证换算
    return { from, start: 0, end: segmentText.length }
  }).map((segment, position) => ({
    ...segment,
    start: segmentTexts.slice(0, position).reduce((sum, part) => sum + part.length + 1, 0),
    end: segmentTexts.slice(0, position).reduce((sum, part) => sum + part.length + 1, 0) + segmentText.length,
  }))
  return { text, segments }
}

describe('findMatchesInText', () => {
  it('maps concatenated positions back to per-segment document positions', () => {
    // 两段文本："hello " 与 "hello"，段间有 \n；from 分别为 10 和 30。
    const segments = [
      { start: 0, end: 6, from: 10 },
      { start: 7, end: 12, from: 30 },
    ]
    const matches = findMatchesInText(
      { text: 'hello \nhello', segments },
      'hello',
      { caseSensitive: false, rangeFrom: 0, rangeTo: 100 },
    )
    expect(matches).toEqual([
      { from: 10, to: 15 },
      { from: 30, to: 35 },
    ])
  })

  it('matches case-insensitively by default and strictly when requested', () => {
    const segments = [{ start: 0, end: 5, from: 0 }]
    const insensitive = findMatchesInText({ text: 'Hello', segments }, 'hello', { caseSensitive: false, rangeFrom: 0, rangeTo: 100 })
    const sensitive = findMatchesInText({ text: 'Hello', segments }, 'hello', { caseSensitive: true, rangeFrom: 0, rangeTo: 100 })
    expect(insensitive).toEqual([{ from: 0, to: 5 }])
    expect(sensitive).toEqual([])
  })

  it('skips matches crossing block separators and honours the search range', () => {
    // "ab" 跨段拼接处不成立；范围内命中保留，范围外剔除。
    const segments = [
      { start: 0, end: 1, from: 0 },
      { start: 2, end: 4, from: 5 },
      { start: 5, end: 7, from: 20 },
    ]
    const matches = findMatchesInText(
      { text: 'a\nbcab', segments },
      'bc',
      { caseSensitive: false, rangeFrom: 0, rangeTo: 10 },
    )
    expect(matches).toEqual([{ from: 5, to: 7 }])
  })

  it('finds repeated occurrences without overlap', () => {
    const segments = [{ start: 0, end: 6, from: 100 }]
    const matches = findMatchesInText({ text: 'aaaaaa', segments }, 'aa', { caseSensitive: true, rangeFrom: 0, rangeTo: 200 })
    expect(matches).toEqual([
      { from: 100, to: 102 },
      { from: 102, to: 104 },
      { from: 104, to: 106 },
    ])
  })

  it('returns nothing for empty queries', () => {
    const segments = [{ start: 0, end: 5, from: 0 }]
    expect(findMatchesInText({ text: 'hello', segments }, '', { caseSensitive: false, rangeFrom: 0, rangeTo: 100 })).toEqual([])
  })
})
