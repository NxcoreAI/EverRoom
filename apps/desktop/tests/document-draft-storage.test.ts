import { afterEach, describe, expect, it } from 'vitest'

import {
  readDocumentDraftRecord,
  removeDocumentDraft,
  shouldRecoverDocumentDraft,
  writeDocumentDraft,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/documentDraftStorage'

const values = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) },
}

Object.defineProperty(globalThis, 'localStorage', { value: localStorageStub, configurable: true })

afterEach(() => values.clear())

describe('document draft persistence', () => {
  it('stores content with the SQLite base version and removes it after persistence', () => {
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '待保存' }] }] }

    expect(writeDocumentDraft('doc-1', content, 4, '独立标题')).toBe(true)
    expect(readDocumentDraftRecord('doc-1')).toMatchObject({ content, title: '独立标题', baseVersion: 4 })

    removeDocumentDraft('doc-1')
    expect(readDocumentDraftRecord('doc-1')).toBeNull()
  })

  it('recovers only a draft that can safely advance the persisted document', () => {
    const persisted = {
      version: 4,
      updatedAt: '2026-08-15T10:00:00.000Z',
      contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    }
    const draft = {
      baseVersion: 4,
      updatedAt: '2026-08-15T10:00:01.000Z',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '新内容' }] }] },
    }

    expect(shouldRecoverDocumentDraft(draft, persisted)).toBe(true)
    expect(shouldRecoverDocumentDraft({ ...draft, baseVersion: 3, updatedAt: '2026-08-15T09:59:59.000Z' }, persisted)).toBe(false)
    expect(shouldRecoverDocumentDraft({ ...draft, content: persisted.contentJson }, persisted)).toBe(false)
  })
})
