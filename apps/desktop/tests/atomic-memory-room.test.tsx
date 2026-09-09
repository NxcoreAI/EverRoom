import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryAtomicItemDto } from '../src/shared/memory'

const listAtomicMock = vi.fn()
const setAtomicRoomMock = vi.fn()

vi.mock('../src/renderer/src/components/context-room/ContextRoomStateProvider', () => ({
  useContextRoomState: () => ({
    state: {
      rooms: [
        { id: 'room-live', title: '上线项目', kind: '项目' },
        { id: 'room-other', title: '周报整理', kind: '主题' },
      ],
      deletedRooms: [],
    },
  }),
}))

import { AtomicMemoryPane } from '../src/renderer/src/components/pages/memory/AtomicMemoryPane'

function atomicItem(overrides: Partial<MemoryAtomicItemDto> & Pick<MemoryAtomicItemDto, 'id'>): MemoryAtomicItemDto {
  return {
    type: 'episodic',
    content: `记忆 ${overrides.id}`,
    background: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    roomId: null,
    roomTitle: null,
    ...overrides,
  }
}

function textOf(node: TestRenderer.ReactTestInstance): string {
  return node.children.flatMap((child) => {
    if (typeof child === 'string') return [child]
    if (child && typeof child === 'object' && 'children' in child) return [textOf(child)]
    return []
  }).join('')
}

function findButtonByText(renderer: TestRenderer.ReactTestRenderer, label: string) {
  // 精确匹配：列表行 summary 按钮的递归文本包含 chip 标题，不能落进去。
  return renderer.root.findAllByType('button').find((button) => textOf(button) === label)
}

function findOptionByTitle(renderer: TestRenderer.ReactTestRenderer, title: string) {
  return renderer.root.findAllByProps({ role: 'option' })
    .find((node) => textOf(node).startsWith(title))
}

async function renderPane() {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<AtomicMemoryPane />)
  })
  return renderer
}

async function expandFirstItem(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.root.findAllByProps({ className: 'mem-atomic-summary' })[0]!.props.onClick()
  })
}

describe('AtomicMemoryPane room attribution', () => {
  beforeEach(() => {
    listAtomicMock.mockReset()
    setAtomicRoomMock.mockReset()
    listAtomicMock.mockResolvedValue({
      items: [
        atomicItem({ id: 'memory-a', roomId: 'room-live', roomTitle: '上线项目' }),
        atomicItem({ id: 'memory-b' }),
        atomicItem({ id: 'memory-c', roomId: 'room-gone', roomTitle: null }),
      ],
      total: 3,
    })
    setAtomicRoomMock.mockResolvedValue({ memoryId: 'memory-a', roomId: 'room-live' })
    ;(globalThis as { window?: unknown }).window = {
      nxcore: { memory: { listAtomic: listAtomicMock, setAtomicRoom: setAtomicRoomMock } },
      dispatchEvent: vi.fn(),
    }
  })

  it('renders the room chip in list rows for bound memories only', async () => {
    const renderer = await renderPane()

    // 可用 chip 是跳转链接（mem-room-chip-link）；不可用 chip 纯展示。
    const linkChips = renderer.root.findAllByProps({ className: 'mem-room-chip mem-room-chip-link' })
    expect(linkChips).toHaveLength(1)
    expect(textOf(linkChips[0]!)).toBe('上线项目')
    expect(linkChips[0]!.props.title).toBe('打开 Room')
    // 绑定行保留但 Room 已不可用：灰 chip。
    const plainChips = renderer.root.findAllByProps({ className: 'mem-room-chip' })
    expect(plainChips).toHaveLength(1)
    expect(textOf(plainChips[0]!)).toBe('Room 已不可用')
  })

  it('shows the assign control in the detail view and reloads after a pick', async () => {
    const renderer = await renderPane()
    await expandFirstItem(renderer)

    // 折叠态 chip 按钮（显示当前归属）。
    const chipButton = findButtonByText(renderer, '上线项目')
    expect(chipButton).toBeTruthy()
    await act(async () => {
      chipButton!.props.onClick()
    })

    // 展开态 listbox：选中「周报整理」。
    const option = findOptionByTitle(renderer, '周报整理')
    expect(option).toBeTruthy()
    await act(async () => {
      option!.props.onClick()
    })

    expect(setAtomicRoomMock).toHaveBeenCalledWith('memory-a', 'room-other', {
      content: '记忆 memory-a',
      type: 'episodic',
      memoryUpdatedAt: '2026-09-01T00:00:00.000Z',
    })
    expect(listAtomicMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    // 选择成功后收起。
    expect(renderer.root.findAllByProps({ role: 'option' })).toHaveLength(0)
  })

  it('clears the binding through the clear button', async () => {
    const renderer = await renderPane()
    await expandFirstItem(renderer)

    await act(async () => {
      findButtonByText(renderer, '清除绑定')!.props.onClick()
    })
    expect(setAtomicRoomMock).toHaveBeenCalledWith('memory-a', null, undefined)
  })

  it('keeps the picker open and surfaces the error when the assignment fails', async () => {
    setAtomicRoomMock.mockRejectedValueOnce(new Error('gateway down'))
    const renderer = await renderPane()
    await expandFirstItem(renderer)

    await act(async () => {
      findButtonByText(renderer, '上线项目')!.props.onClick()
    })
    const option = findOptionByTitle(renderer, '周报整理')
    await act(async () => {
      option!.props.onClick()
    })

    expect(renderer.root.findAllByProps({ className: 'mem-inline-error' }).length).toBeGreaterThan(0)
    expect(renderer.root.findAllByProps({ role: 'option' }).length).toBeGreaterThan(0)
  })
})
