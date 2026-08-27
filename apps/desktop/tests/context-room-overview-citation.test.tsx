/** @vitest-environment happy-dom */

import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RoomOverviewCitationControls,
  readRoomOverviewTextSelection,
  roomOverviewCitationBadgePoint,
} from '../src/renderer/src/components/context-room/RoomOverviewCitationControls'
import {
  clearRoomOverviewCitation,
  ROOM_OVERVIEW_CITATION_ADD_EVENT,
  ROOM_OVERVIEW_CITATION_SECTIONS,
  type RoomOverviewCitation,
} from '../src/renderer/src/components/context-room/roomOverviewCitation'

const selectionRect = {
  bottom: 120,
  height: 20,
  left: 100,
  right: 220,
  top: 100,
  width: 120,
} as DOMRect

function fakeSelection(element: HTMLElement, text = element.textContent ?? '') {
  const range = {
    cloneRange: () => range,
    getBoundingClientRect: () => selectionRect,
  } as unknown as Range
  return {
    anchorNode: element.firstChild,
    focusNode: element.firstChild,
    getRangeAt: () => range,
    isCollapsed: false,
    rangeCount: 1,
    removeAllRanges: vi.fn(),
    toString: () => text,
  } as unknown as Selection
}

function CitationFixture() {
  const rootRef = useRef<HTMLElement>(null)
  return (
    <section ref={rootRef} data-testid="citation-root">
      <RoomOverviewCitationControls rootRef={rootRef} roomId="room-1" roomTitle="产品发布" />
      {ROOM_OVERVIEW_CITATION_SECTIONS.map((section) => (
        <p key={section} data-room-citation-section={section}>
          <span data-room-citation-claim-id={`${section}:claim-1`}>{section} content</span>
          {section === 'overview' ? <span data-room-citation-claim-id="overview:claim-2">second overview claim</span> : null}
        </p>
      ))}
      <p data-testid="unsupported">latest resources content</p>
      <p data-room-citation-section="resources">invalid section content</p>
    </section>
  )
}

describe('Room overview selected-text citation UI', () => {
  let container: HTMLDivElement
  let root: Root
  let currentSelection: Selection | null
  const highlights = { delete: vi.fn(), set: vi.fn() }

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    currentSelection = null
    vi.spyOn(document, 'getSelection').mockImplementation(() => currentSelection)
    Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { highlights } })
    Object.defineProperty(window, 'Highlight', {
      configurable: true,
      value: class Highlight {
        constructor(readonly range: Range) {}
      },
    })
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
    await act(async () => root.render(<CitationFixture />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    highlights.delete.mockReset()
    highlights.set.mockReset()
  })

  it('accepts selections only inside the five supported sections', () => {
    const citationRoot = container.querySelector<HTMLElement>('[data-testid="citation-root"]')!
    for (const section of ROOM_OVERVIEW_CITATION_SECTIONS) {
      const element = container.querySelector<HTMLElement>(`[data-room-citation-section="${section}"]`)!
      expect(readRoomOverviewTextSelection(citationRoot, fakeSelection(element))?.section).toBe(section)
    }

    const unsupported = container.querySelector<HTMLElement>('[data-testid="unsupported"]')!
    const invalid = container.querySelector<HTMLElement>('[data-room-citation-section="resources"]')!
    expect(readRoomOverviewTextSelection(citationRoot, fakeSelection(unsupported))).toBeNull()
    expect(readRoomOverviewTextSelection(citationRoot, fakeSelection(invalid))).toBeNull()
  })

  it('captures every claim crossed by a selection in the same section', () => {
    const citationRoot = container.querySelector<HTMLElement>('[data-testid="citation-root"]')!
    const claims = container.querySelectorAll<HTMLElement>('[data-room-citation-section="overview"] [data-room-citation-claim-id]')
    const range = {
      cloneRange: () => range,
      getBoundingClientRect: () => selectionRect,
      intersectsNode: (node: Node) => [...claims].includes(node as HTMLElement),
    } as unknown as Range
    const selection = {
      anchorNode: claims[0]!.firstChild,
      focusNode: claims[1]!.firstChild,
      getRangeAt: () => range,
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'overview content second overview claim',
    } as unknown as Selection

    expect(readRoomOverviewTextSelection(citationRoot, selection)?.claimRefs).toEqual([
      { claimId: 'overview:claim-1', text: 'overview content' },
      { claimId: 'overview:claim-2', text: 'second overview claim' },
    ])
  })

  it('does not offer the action for unsupported content', async () => {
    const citationRoot = container.querySelector<HTMLElement>('[data-testid="citation-root"]')!
    const unsupported = container.querySelector<HTMLElement>('[data-testid="unsupported"]')!
    currentSelection = fakeSelection(unsupported)

    await act(async () => citationRoot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))

    expect(container.querySelector('.context-room-selection-to-agent')).toBeNull()
  })

  it('dismisses a pending action on scroll and hides a cited badge outside the viewport', async () => {
    const citationRoot = container.querySelector<HTMLElement>('[data-testid="citation-root"]')!
    const overview = container.querySelector<HTMLElement>('[data-room-citation-section="overview"]')!
    currentSelection = fakeSelection(overview)
    await act(async () => citationRoot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    expect(container.querySelector('.context-room-selection-to-agent')).not.toBeNull()

    await act(async () => citationRoot.dispatchEvent(new Event('scroll')))
    expect(container.querySelector('.context-room-selection-to-agent')).toBeNull()
    expect(roomOverviewCitationBadgePoint({
      top: window.innerHeight + 20,
      bottom: window.innerHeight + 40,
      left: 20,
      right: 120,
    })).toBeNull()
  })

  it('does not create a citation when the optional-comment step is cancelled', async () => {
    const citations: RoomOverviewCitation[] = []
    const receiveCitation = (event: Event) => citations.push((event as CustomEvent<RoomOverviewCitation>).detail)
    window.addEventListener(ROOM_OVERVIEW_CITATION_ADD_EVENT, receiveCitation)
    const citationRoot = container.querySelector<HTMLElement>('[data-testid="citation-root"]')!
    const overview = container.querySelector<HTMLElement>('[data-room-citation-section="overview"]')!
    currentSelection = fakeSelection(overview, '尚未确认的引用')

    await act(async () => citationRoot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    await act(async () => container.querySelector<HTMLButtonElement>('.context-room-selection-to-agent')?.click())
    expect(container.querySelector('.context-room-citation-comment')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('.context-room-citation-comment-cancel')?.click())

    expect(citations).toHaveLength(0)
    expect(container.querySelector('.context-room-citation-comment')).toBeNull()
    expect(container.querySelector('.context-room-citation-badge')).toBeNull()
    window.removeEventListener(ROOM_OVERVIEW_CITATION_ADD_EVENT, receiveCitation)
  })

  it('collects an optional comment before adding multiple citations and clears them independently', async () => {
    const citations: RoomOverviewCitation[] = []
    const receiveCitation = (event: Event) => citations.push((event as CustomEvent<RoomOverviewCitation>).detail)
    window.addEventListener(ROOM_OVERVIEW_CITATION_ADD_EVENT, receiveCitation)
    const citationRoot = container.querySelector<HTMLElement>('[data-testid="citation-root"]')!

    const selectAndAdd = async (section: 'overview' | 'status', text: string, comment = '') => {
      const citationCountBefore = citations.length
      const badgeCountBefore = container.querySelectorAll('.context-room-citation-badge').length
      const element = container.querySelector<HTMLElement>(`[data-room-citation-section="${section}"]`)!
      currentSelection = fakeSelection(element, text)
      await act(async () => citationRoot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
      const action = container.querySelector<HTMLButtonElement>('.context-room-selection-to-agent')
      expect(action?.textContent).toContain('添加到智能区')
      await act(async () => action?.click())
      expect(citations).toHaveLength(citationCountBefore)
      expect(container.querySelectorAll('.context-room-citation-badge')).toHaveLength(badgeCountBefore)
      const input = container.querySelector<HTMLInputElement>('.context-room-citation-comment input')!
      if (comment) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, comment)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
      }
      await act(async () => container.querySelector<HTMLButtonElement>('.context-room-citation-comment-add')?.click())
    }

    await selectAndAdd('overview', '第一段引用', '这里的目标已经变化')
    expect(citations[0]).toMatchObject({
      roomId: 'room-1', section: 'overview', text: '第一段引用', comment: '这里的目标已经变化',
      claimRefs: [{ claimId: 'overview:claim-1', text: 'overview content' }],
    })
    expect(container.querySelector('.context-room-citation-badge')).not.toBeNull()

    await selectAndAdd('status', '第二段状态引用')
    expect(citations[1]).toMatchObject({ roomId: 'room-1', section: 'status', text: '第二段状态引用' })
    expect(citations[1]?.comment).toBeUndefined()
    expect(container.querySelectorAll('.context-room-citation-badge')).toHaveLength(2)

    await act(async () => clearRoomOverviewCitation(citations[1].id))
    expect(container.querySelectorAll('.context-room-citation-badge')).toHaveLength(1)
    await act(async () => clearRoomOverviewCitation(citations[0].id))
    expect(container.querySelectorAll('.context-room-citation-badge')).toHaveLength(0)
    window.removeEventListener(ROOM_OVERVIEW_CITATION_ADD_EVENT, receiveCitation)
  })
})
