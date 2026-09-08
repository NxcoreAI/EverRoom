import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalDocumentComment } from '../src/shared/sources'

const listMock = vi.fn()
const resolveMock = vi.fn()
const deleteMock = vi.fn()
const importHistoryMock = vi.fn()
const documentEventListenerMock = vi.fn()
const windowAddEventListener = vi.fn()
const windowRemoveEventListener = vi.fn()
let documentEventListeners: Array<(frame: unknown) => void> = []

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

async function renderPanel(options: { expandUnlocated?: boolean } = {}) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      <ImportedCommentsPanel editor={null} roomId="room-1" documentId="doc-1" onClose={() => {}} />,
    )
  })
  // 未定位区默认折叠；需要断言其内容的用例先点开折叠头。
  if (options.expandUnlocated) {
    const toggle = renderer.root.findByProps({ 'aria-expanded': false })
    await act(async () => {
      toggle.props.onClick()
    })
  }
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
  documentEventListeners = []
  listMock.mockResolvedValue({ items: [localComment({ id: 'comment-a' })] })
  resolveMock.mockResolvedValue(localComment({ id: 'comment-a', resolved: true }))
  importHistoryMock.mockResolvedValue({ comments: [] })
  ;(globalThis as { window?: unknown }).window = {
    nxcore: {
      documents: {
        listDocumentComments: listMock,
        resolveDocumentComment: resolveMock,
        deleteDocumentComment: deleteMock,
        onEvent: (listener: (frame: unknown) => void) => {
          documentEventListeners.push(listener)
          return () => {
            documentEventListeners = documentEventListeners.filter((item) => item !== listener)
          }
        },
      },
      externalDocuments: { importHistory: importHistoryMock },
    },
    addEventListener: windowAddEventListener,
    removeEventListener: windowRemoveEventListener,
    dispatchEvent: vi.fn(),
  }
})

function emitDocumentEvent(frame: unknown): void {
  for (const listener of [...documentEventListeners]) listener(frame)
}

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
    const renderer = await renderPanel({ expandUnlocated: true })
    const resolveButton = renderer.root.findAllByProps({ title: '解决/重新打开' })
    expect(resolveButton.length).toBeGreaterThan(0)

    await act(async () => {
      resolveButton[0]!.props.onClick()
    })
    expect(resolveMock).toHaveBeenCalledWith('doc-1', 'comment-a', true)
  })

  it('renders local comment bodies in the unlocated section when no editor is available', async () => {
    const renderer = await renderPanel({ expandUnlocated: true })
    const section = renderer.root.findByProps({ className: 'context-room-imported-comments-unanchored' })
    expect(textOf(section)).toContain('评论 comment-a')
  })

  it('shows the AI badge for agent-authored comments only', async () => {
    listMock.mockResolvedValue({
      items: [
        localComment({ id: 'mine', body: '我的评论' }),
        localComment({ id: 'ai', body: 'AI 建议', authorName: 'AI 审阅' }),
      ],
    })
    const renderer = await renderPanel({ expandUnlocated: true })
    const badges = renderer.root.findAllByProps({ className: 'context-room-imported-comment-ai-author' })
    expect(badges).toHaveLength(1)
    expect(textOf(badges[0]!)).toBe('AI 审阅')
    // 未定位区里 AI 评论与我的评论都在，但只有一个徽标。
    const section = renderer.root.findByProps({ className: 'context-room-imported-comments-unanchored' })
    expect(textOf(section)).toContain('我的评论')
    expect(textOf(section)).toContain('AI 建议')
  })

  it('reloads on document.comments.changed push events for this document only', async () => {
    await renderPanel()
    listMock.mockClear()
    emitDocumentEvent({ type: 'document.event', protocol: 1, event: { type: 'document.comments.changed', documentId: 'doc-1' } })
    await act(async () => {})
    expect(listMock).toHaveBeenCalledTimes(1)
    emitDocumentEvent({ type: 'document.event', protocol: 1, event: { type: 'document.comments.changed', documentId: 'doc-other' } })
    emitDocumentEvent({ type: 'document.event', protocol: 1, event: { type: 'document.changed', documentId: 'doc-1' } })
    await act(async () => {})
    expect(listMock).toHaveBeenCalledTimes(1)
  })
})
