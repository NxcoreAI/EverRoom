import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalDocumentComment } from '../src/shared/sources'

const listMock = vi.fn()
const resolveMock = vi.fn()
const deleteMock = vi.fn()
const importHistoryMock = vi.fn()
const windowAddEventListener = vi.fn()
const windowRemoveEventListener = vi.fn()

import { ImportedCommentsPanel } from '../src/renderer/src/components/context-room/ported/components/detail-editor/ImportedCommentsPanel'

function localComment(overrides: Partial<LocalDocumentComment> & Pick<LocalDocumentComment, 'id'>): LocalDocumentComment {
  return {
    parentId: null,
    blockId: null,
    quotedText: null,
    body: `评论 ${overrides.id}`,
    authorName: '我',
    resolved: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

async function renderPanel() {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      <ImportedCommentsPanel editor={null} roomId="room-1" documentId="doc-1" onClose={() => {}} />,
    )
  })
  return renderer
}

function textOf(node: TestRenderer.ReactTestInstance): string {
  return node.children.flatMap((child) => {
    if (typeof child === 'string') return [child]
    if (child && typeof child === 'object' && 'children' in child) return [textOf(child)]
    return []
  }).join('')
}

beforeEach(() => {
  listMock.mockReset()
  resolveMock.mockReset()
  deleteMock.mockReset()
  importHistoryMock.mockReset()
  listMock.mockResolvedValue({ items: [localComment({ id: 'comment-a' })] })
  resolveMock.mockResolvedValue(localComment({ id: 'comment-a', resolved: true }))
  importHistoryMock.mockResolvedValue({ comments: [] })
  ;(globalThis as { window?: unknown }).window = {
    nxcore: {
      documents: {
        listDocumentComments: listMock,
        resolveDocumentComment: resolveMock,
        deleteDocumentComment: deleteMock,
      },
      externalDocuments: { importHistory: importHistoryMock },
    },
    addEventListener: windowAddEventListener,
    removeEventListener: windowRemoveEventListener,
    dispatchEvent: vi.fn(),
  }
})

describe('ImportedCommentsPanel', () => {
  it('renders nothing while collapsed but still loads comments for marking', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <ImportedCommentsPanel
          editor={null}
          roomId="room-1"
          documentId="doc-1"
          collapsed
          onOpen={() => {}}
          onClose={() => {}}
        />,
      )
    })
    expect(renderer.toJSON()).toBeNull()
    expect(listMock).toHaveBeenCalledWith('doc-1')
    expect(importHistoryMock).toHaveBeenCalledWith('room-1', 'doc-1')
  })

  it('unanchored local cards expose the resolve toggle', async () => {
    const renderer = await renderPanel()
    const resolveButton = renderer.root.findAllByProps({ title: '解决/重新打开' })
    expect(resolveButton.length).toBeGreaterThan(0)

    await act(async () => {
      resolveButton[0]!.props.onClick()
    })
    expect(resolveMock).toHaveBeenCalledWith('doc-1', 'comment-a', true)
  })

  it('renders local comment bodies in the unlocated section when no editor is available', async () => {
    const renderer = await renderPanel()
    const section = renderer.root.findByProps({ className: 'context-room-imported-comments-unanchored' })
    expect(textOf(section)).toContain('评论 comment-a')
  })
})
