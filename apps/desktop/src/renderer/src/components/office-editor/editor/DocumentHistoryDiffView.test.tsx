// @vitest-environment happy-dom

import type { DocumentDiffResult, DocumentVersionSnapshot } from '@nxcore/agent-contract'
import type { Editor } from '@tiptap/react'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../i18n/LocaleContext', () => ({
  useLocale: () => ({
    locale: 'zh-CN',
    t: (key: string) => key,
  }),
}))

import { applyDocumentHistoryInlineDiff, DocumentHistoryDiffView } from './DocumentHistoryDiffView'

const snapshot: DocumentVersionSnapshot = {
  documentId: 'document-1',
  version: 1,
  title: 'Earlier title',
  contentJson: { type: 'doc', content: [] },
  contentSchemaVersion: 1,
  sourceTransactionId: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  yjsBackfilled: true,
}

const diff: DocumentDiffResult = {
  documentId: 'document-1',
  fromVersion: 1,
  toVersion: 2,
  blocks: [],
  yjsBackfilled: true,
}

const editor = { isDestroyed: false } as unknown as Editor

function render(currentTitle: string) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <DocumentHistoryDiffView
        editor={editor}
        snapshot={snapshot}
        diff={diff}
        currentTitle={currentTitle}
      />,
    )
  })
  return renderer
}

describe('DocumentHistoryDiffView', () => {
  it('shows an unchanged document title once', () => {
    const renderer = render(snapshot.title)
    const titles = renderer.root.findAllByType('h1')

    expect(titles).toHaveLength(1)
    expect(titles[0]?.children).toEqual([snapshot.title])
    expect(titles[0]?.props.className).toBe('is-unchanged')
  })

  it('shows both document titles when the title changed', () => {
    const renderer = render('Current title')
    const titles = renderer.root.findAllByType('h1')

    expect(titles.map((title) => title.children[0])).toEqual(['Earlier title', 'Current title'])
    expect(titles.map((title) => title.props.className)).toEqual(['is-removed', 'is-added'])
  })

  it('keeps diff content in the editor scroll container', () => {
    const renderer = render(snapshot.title)
    const content = renderer.root.findByProps({ className: 'context-room-history-diff-content' })

    expect(content.props.className).not.toContain('context-room-history-diff-scroll')
    expect(renderer.root.findAllByProps({ className: 'context-room-history-diff-content' })).toHaveLength(1)
  })

  it('marks multiple edits at their exact positions in one rich-text block', () => {
    const root = document.createElement('p')
    root.textContent = 'TypeScript 是微软维护的语言，它非常好。'

    applyDocumentHistoryInlineDiff(root, [
      { type: 'equal', text: 'TypeScript 是微软' },
      { type: 'delete', text: '开发' },
      { type: 'insert', text: '维护' },
      { type: 'equal', text: '的语言' },
      { type: 'delete', text: '。' },
      { type: 'insert', text: '，' },
      { type: 'equal', text: '它' },
      { type: 'delete', text: '很' },
      { type: 'insert', text: '非常' },
      { type: 'equal', text: '好。' },
    ])

    expect([...root.querySelectorAll('del')].map((node) => node.textContent)).toEqual(['开发', '。', '很'])
    expect([...root.querySelectorAll('ins')].map((node) => node.textContent)).toEqual(['维护', '，', '非常'])
    expect(root.querySelectorAll('[data-diff-type]')).toHaveLength(6)
  })

  it('keeps inline formatting while decorating replacements', () => {
    const root = document.createElement('p')
    root.append('安装 ')
    const code = document.createElement('code')
    code.textContent = 'tsx'
    root.append(code, ' 命令')

    applyDocumentHistoryInlineDiff(root, [
      { type: 'equal', text: '安装 ' },
      { type: 'delete', text: 'tsc' },
      { type: 'insert', text: 'tsx' },
      { type: 'equal', text: ' 命令' },
    ])

    expect(code.querySelector('del')?.textContent).toBe('tsc')
    expect(code.querySelector('ins')?.textContent).toBe('tsx')
    expect(root.querySelectorAll('code')).toHaveLength(1)
  })

  it('places a deletion at the end without duplicating the surrounding text', () => {
    const root = document.createElement('p')
    root.textContent = '正文第一段'

    applyDocumentHistoryInlineDiff(root, [
      { type: 'equal', text: '正文第一段' },
      { type: 'delete', text: '。' },
    ])

    expect(root.textContent).toBe('正文第一段。')
    expect(root.querySelector('del')?.textContent).toBe('。')
    expect(root.querySelectorAll('ins')).toHaveLength(0)
  })
})
