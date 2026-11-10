// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18next', () => ({
  default: { getFixedT: () => (key: string) => key },
}))

import {
  buildDocumentCursorCompletionPrompt,
  type DocumentCursorCompletionRequest,
} from './documentCursorCompletionAgent'

const baseRequest: DocumentCursorCompletionRequest = {
  roomId: 'room-1',
  documentName: '发布方案',
  contextBefore: '前文。',
  contextAfter: '后文。',
  blockPrefix: '前文。',
  blockType: 'paragraph',
  formatContext: { ancestorTypes: [], activeMarks: [] },
}

describe('buildDocumentCursorCompletionPrompt 写作风格注入（§7.1）', () => {
  it('未传 writingStyleBlock 时无 WRITING_STYLE 标签', () => {
    const prompt = buildDocumentCursorCompletionPrompt(baseRequest)
    expect(prompt).not.toContain('<WRITING_STYLE>')
    expect(prompt).not.toContain('writing_style')
  })

  it('传入时标签位于 EDITOR_CONTEXT 之后，且保留原块内容', () => {
    const block = '<writing_style>\n用户明确要求（最高优先级）：少用感叹号\n</writing_style>'
    const prompt = buildDocumentCursorCompletionPrompt({ ...baseRequest, writingStyleBlock: block })
    expect(prompt).toContain('<WRITING_STYLE>')
    expect(prompt.indexOf('</EDITOR_CONTEXT>')).toBeLessThan(prompt.indexOf('<WRITING_STYLE>'))
    expect(prompt).toContain('少用感叹号')
    expect(prompt).toContain('<PREFIX>')
    expect(prompt).toContain('<CURSOR />')
  })
})
