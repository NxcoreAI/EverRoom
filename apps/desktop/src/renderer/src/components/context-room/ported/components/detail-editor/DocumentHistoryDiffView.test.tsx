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

import { DocumentHistoryDiffView } from './DocumentHistoryDiffView'

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
})
