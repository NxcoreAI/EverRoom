import { describe, expect, it } from 'vitest'

import { arbitrateFocus } from './useRoomFocus'

const CHAPTER = { heading: '二、发布节奏', bodyText: '正文若干' }

describe('arbitrateFocus 优先级链（selection > chapter > document > room）', () => {
  it('选区压过一切', () => {
    const result = arbitrateFocus('选中一句话', CHAPTER, 'doc-1', '发布计划')
    expect(result.level).toBe('selection')
    expect(result.label).toBeNull()
    expect(result.trigger).toBe('selection-settle')
  })

  it('章节次之：label=章节标题，trigger=chapter-stable', () => {
    const result = arbitrateFocus(null, CHAPTER, 'doc-1', '发布计划')
    expect(result.level).toBe('chapter')
    expect(result.label).toBe('二、发布节奏')
    expect(result.trigger).toBe('chapter-stable')
  })

  it('章节正文为空：不算章节，落到产物', () => {
    const result = arbitrateFocus(null, { heading: '二、发布节奏', bodyText: '   ' }, 'doc-1', '发布计划')
    expect(result.level).toBe('document')
    expect(result.label).toBe('发布计划')
    expect(result.trigger).toBe('document-open')
  })

  it('章节无标题：级别仍是章节，label 兜底产物标题', () => {
    const result = arbitrateFocus(null, { heading: null, bodyText: '正文若干' }, 'doc-1', '发布计划')
    expect(result.level).toBe('chapter')
    expect(result.label).toBe('发布计划')
  })

  it('无选区无章节有产物：document', () => {
    const result = arbitrateFocus(null, null, 'doc-1', '发布计划')
    expect(result.level).toBe('document')
    expect(result.label).toBe('发布计划')
  })

  it('只剩房间：room，label 为空由视图兜底', () => {
    const result = arbitrateFocus(null, null, null, null)
    expect(result.level).toBe('room')
    expect(result.label).toBeNull()
    expect(result.trigger).toBe('panel-open')
  })
})
