/** @vitest-environment happy-dom */

import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      locale: 'zh-CN',
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
    }),
  }
})

import { createContextRoomFixture } from './context-room-fixture'
import { HomeView } from '../src/renderer/src/components/context-room/ported/components/HomeView'
import { RoomCard } from '../src/renderer/src/components/context-room/ported/components/RoomCard'

function room(id: string, title: string, updatedAt?: string) {
  return { ...createContextRoomFixture(id, title), updatedAt, lastViewed: '刚刚' }
}

const handlers = {
  onRenameRoom: vi.fn(),
  onDeleteRoom: vi.fn(),
  onRestoreRoom: vi.fn(),
  onOpenDetail: vi.fn(),
  onShowAll: vi.fn(),
  onFocusAgent: vi.fn(),
  onRefreshRooms: vi.fn().mockResolvedValue(undefined),
}

function renderHome(rooms: ReturnType<typeof room>[]) {
  return TestRenderer.create(
    <HomeView rooms={rooms} deletedRooms={[]} {...handlers} />,
  )
}

describe('首页「我的 Room」卡片排序', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
  })

  it('按更新时间倒序，缺时间戳的旧记录沉底', async () => {
    // 传入顺序故意乱序：旧 → 无时间戳 → 最新
    await act(async () => {
      renderer = renderHome([
        room('room-old', '旧 Room', '2026-08-01T08:00:00.000Z'),
        room('room-legacy', '旧记录 Room', undefined),
        room('room-new', '最新 Room', '2026-08-27T09:00:00.000Z'),
      ])
    })
    const cards = renderer!.root.findAllByType(RoomCard)
    expect(cards.map((card) => card.props.room.title)).toEqual([
      '最新 Room',
      '旧 Room',
      '旧记录 Room',
    ])
  })

  it('搜索结果同样按更新时间倒序', async () => {
    await act(async () => {
      renderer = renderHome([
        room('room-a', '发布 Room', '2026-08-01T08:00:00.000Z'),
        room('room-b', '发布计划', '2026-08-26T08:00:00.000Z'),
        room('room-c', '评审 Room', '2026-08-20T08:00:00.000Z'),
      ])
    })
    const search = renderer!.root.findByProps({ 'aria-label': '搜索我的 Room' })
    await act(async () => {
      search.props.onChange({ target: { value: 'Room' } })
    })
    const cards = renderer!.root.findAllByType(RoomCard)
    // 命中“发布 Room”“评审 Room”两条，按更新时间倒序
    expect(cards.map((card) => card.props.room.title)).toEqual(['评审 Room', '发布 Room'])
  })
})
