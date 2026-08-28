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
  buildRoomOverviewCitationContext,
  buildRoomOverviewCitationPrompt,
  clearRoomOverviewCitation,
  ROOM_OVERVIEW_CITATION_ADD_EVENT,
  ROOM_OVERVIEW_CITATION_SECTIONS,
  ROOM_OVERVIEW_CITATION_UPDATE_EVENT,
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

  it('edits and revokes a citation comment from its badge', async () => {
    const added: RoomOverviewCitation[] = []
    const updates: RoomOverviewCitation[] = []
    const receiveAdd = (event: Event) => added.push((event as CustomEvent<RoomOverviewCitation>).detail)
    const receiveUpdate = (event: Event) => updates.push((event as CustomEvent<RoomOverviewCitation>).detail)
    window.addEventListener(ROOM_OVERVIEW_CITATION_ADD_EVENT, receiveAdd)
    window.addEventListener(ROOM_OVERVIEW_CITATION_UPDATE_EVENT, receiveUpdate)
    const citationRoot = container.querySelector<HTMLElement>('[data-testid="citation-root"]')!
    const overview = container.querySelector<HTMLElement>('[data-room-citation-section="overview"]')!
    currentSelection = fakeSelection(overview, '需要纠正的引用')

    await act(async () => citationRoot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    await act(async () => container.querySelector<HTMLButtonElement>('.context-room-selection-to-agent')?.click())
    const pendingInput = container.querySelector<HTMLInputElement>('.context-room-citation-comment input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(pendingInput, '原始评论')
      pendingInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLButtonElement>('.context-room-citation-comment-add')?.click())
    expect(added).toHaveLength(1)
    expect(updates).toHaveLength(0)

    const badge = () => container.querySelector<HTMLButtonElement>('.context-room-citation-badge')!
    expect(badge().title).toBe('原始评论')
    await act(async () => badge().click())
    const editor = container.querySelector<HTMLFormElement>('.context-room-citation-edit')!
    const editInput = editor.querySelector<HTMLInputElement>('input')!
    expect(editInput.value).toBe('原始评论')
    expect(editor.querySelector('.context-room-citation-edit-revoke')?.textContent).toContain('撤销')

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(editInput, '  修改后的评论  ')
      editInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => editor.querySelector<HTMLButtonElement>('.context-room-citation-comment-add')?.click())

    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ id: added[0]?.id, text: '需要纠正的引用', comment: '修改后的评论' })
    expect(added).toHaveLength(1)
    expect(container.querySelector('.context-room-citation-edit')).toBeNull()
    expect(badge().title).toBe('修改后的评论')

    await act(async () => badge().click())
    const revokeEditor = container.querySelector<HTMLFormElement>('.context-room-citation-edit')!
    await act(async () => revokeEditor.querySelector<HTMLButtonElement>('.context-room-citation-edit-revoke')?.click())

    expect(updates).toHaveLength(2)
    expect('comment' in (updates[1] as RoomOverviewCitation)).toBe(false)
    expect(badge().title).toBe('这段内容已被智能区引用')
    expect(container.querySelectorAll('.context-room-citation-badge')).toHaveLength(1)
    window.removeEventListener(ROOM_OVERVIEW_CITATION_ADD_EVENT, receiveAdd)
    window.removeEventListener(ROOM_OVERVIEW_CITATION_UPDATE_EVENT, receiveUpdate)
  })

  it('keeps the comment when the badge editor is closed by clicking blank space', async () => {
    const updates: RoomOverviewCitation[] = []
    const receiveUpdate = (event: Event) => updates.push((event as CustomEvent<RoomOverviewCitation>).detail)
    window.addEventListener(ROOM_OVERVIEW_CITATION_UPDATE_EVENT, receiveUpdate)
    const citationRoot = container.querySelector<HTMLElement>('[data-testid="citation-root"]')!
    const overview = container.querySelector<HTMLElement>('[data-room-citation-section="overview"]')!
    currentSelection = fakeSelection(overview, '保持不变的引用')

    await act(async () => citationRoot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    await act(async () => container.querySelector<HTMLButtonElement>('.context-room-selection-to-agent')?.click())
    const pendingInput = container.querySelector<HTMLInputElement>('.context-room-citation-comment input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(pendingInput, '不要动我')
      pendingInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLButtonElement>('.context-room-citation-comment-add')?.click())

    await act(async () => container.querySelector<HTMLButtonElement>('.context-room-citation-badge')?.click())
    const editor = container.querySelector<HTMLFormElement>('.context-room-citation-edit')!
    const editInput = editor.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(editInput, '误输入的内容')
      editInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))

    expect(updates).toHaveLength(0)
    expect(container.querySelector('.context-room-citation-edit')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('.context-room-citation-badge')?.title).toBe('不要动我')
    window.removeEventListener(ROOM_OVERVIEW_CITATION_UPDATE_EVENT, receiveUpdate)
  })
})

describe('引用纠正发送提示词', () => {
  function citationFixture(overrides: Partial<RoomOverviewCitation>): RoomOverviewCitation {
    return {
      id: overrides.id ?? 'cit-1',
      roomId: 'room-1',
      roomTitle: 'College Life',
      section: 'timeline',
      text: '学校开学 9 月 1 日报到',
      ...overrides,
    }
  }

  it('单条评论带房间与区块上下文，编号对齐引用上下文', () => {
    const citations = [citationFixture({ comment: ' 时间写错了，是 9 月 21 日 ' })]
    const prompt = buildRoomOverviewCitationPrompt(citations)

    expect(prompt).toContain('「College Life」')
    expect(prompt).toContain('引用 1（Room 时间轴「学校开学 9 月 1 日报到」）：时间写错了，是 9 月 21 日')
    expect(prompt).toContain('纠正或澄清')
    // 引用上下文行格式与 gateway ROOM_OVERVIEW_CITATION_CONTEXT 正则耦合，锁死不漂移。
    expect(buildRoomOverviewCitationContext(citations)).toBe([
      '引用 1',
      '区块：timeline',
      '引用文本：学校开学 9 月 1 日报到',
      '用户评论：时间写错了，是 9 月 21 日',
    ].join('\n'))
  })

  it('多条评论逐条对位，未附评论的引用占位防止错配', () => {
    const prompt = buildRoomOverviewCitationPrompt([
      citationFixture({ id: 'cit-1', section: 'overview', text: '总览第一段内容', comment: '补充：这是大一学年' }),
      citationFixture({ id: 'cit-2' }),
      citationFixture({ id: 'cit-3', section: 'status', text: '状态行', comment: '这条已过时' }),
    ])

    const lines = prompt.split('\n')
    expect(lines[0]).toContain('3 条评论')
    expect(lines[1]).toBe('引用 1（Room 简介「总览第一段内容」）：补充：这是大一学年')
    expect(lines[2]).toBe('引用 2（Room 时间轴「学校开学 9 月 1 日报到」）：未附评论，仅作参考背景')
    expect(lines[3]).toBe('引用 3（当前状态「状态行」）：这条已过时')
  })

  it('全部没有评论时返回空串，长引用文本截断到 32 字', () => {
    expect(buildRoomOverviewCitationPrompt([citationFixture({})])).toBe('')
    const longText = '长'.repeat(40)
    const prompt = buildRoomOverviewCitationPrompt([citationFixture({ text: longText, comment: '评论' })])
    expect(prompt).toContain(`「${'长'.repeat(32)}…」`)
  })

  it('en-US 输出英文提示词', () => {
    const prompt = buildRoomOverviewCitationPrompt([citationFixture({ comment: 'wrong date' })], 'en-US')
    expect(prompt).toContain('"College Life"')
    expect(prompt).toContain('Citation 1 (Room timeline "学校开学 9 月 1 日报到"): wrong date')
  })
})
