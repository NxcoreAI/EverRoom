/** @vitest-environment happy-dom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ContextRoomSnapshot } from '@nxcore/agent-contract'

import { ContextRoomStateProvider, useContextRoomState } from '../src/renderer/src/components/context-room/ContextRoomStateProvider'
import type { ContextRoomLocalState } from '../src/renderer/src/components/context-room/ported/contextRoomLocalState'
import { ROOM_OVERVIEW_CHANGED_EVENT } from '../src/renderer/src/components/context-room/roomOverviewChange'
import { createContextRoomFixture } from './context-room-fixture'

type ContextRoomsApi = NonNullable<Window['nxcore']>['contextRooms']

/** 网关出口会把投影变化时间合进 data.updatedAt，卡片“最近更新”才会跟随纠正/日程变化。 */
function snapshotWithUpdatedAt(updatedAt: string): ContextRoomSnapshot {
  const room = { ...createContextRoomFixture('room-refresh', '刷新 Room'), updatedAt }
  return {
    rooms: [{ id: room.id, title: room.title, kind: room.kind, data: room }],
    deletedRooms: [],
    updatedAt,
  }
}

describe('ContextRoomStateProvider 投影变化重拉', () => {
  let container: HTMLElement
  let root: Root
  let list: ReturnType<typeof vi.fn>
  let latest: ContextRoomLocalState | null

  function publishChange() {
    window.dispatchEvent(new CustomEvent(ROOM_OVERVIEW_CHANGED_EVENT, { detail: { roomId: 'room-refresh' } }))
  }

  function Probe() {
    latest = useContextRoomState().state
    return null
  }

  beforeEach(() => {
    vi.useFakeTimers()
    window.localStorage.clear()
    list = vi.fn()
    let snapshot = snapshotWithUpdatedAt('2026-08-28T04:00:00.000Z')
    list.mockImplementation(async () => snapshot)
    const contextRooms = {
      list,
      // 上行同步直接回显当前快照，初始空状态本身不触发，仅防御性兜底。
      syncSnapshot: vi.fn(async () => snapshot),
    } as unknown as ContextRoomsApi
    ;(window as unknown as { nxcore?: unknown }).nxcore = { contextRooms }
    // 事件触发后网关已推进投影时间：第二次 list 返回更新的快照。
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    latest = null
    act(() => {
      root.render(
        <ContextRoomStateProvider>
          <Probe />
        </ContextRoomStateProvider>,
      )
    })
    snapshot = snapshotWithUpdatedAt('2026-08-28T12:00:00.000Z')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    delete (window as unknown as { nxcore?: unknown }).nxcore
    vi.useRealTimers()
  })

  it('防抖 500ms 后重拉快照，房间 updatedAt 跟随投影变化', async () => {
    expect(list).not.toHaveBeenCalled()
    expect(latest?.rooms).toHaveLength(0)

    act(() => publishChange())
    act(() => { vi.advanceTimersByTime(499) })
    // 防抖窗口内不拉。
    expect(list).not.toHaveBeenCalled()

    await act(async () => { vi.advanceTimersByTime(1) })
    expect(list).toHaveBeenCalledTimes(1)
    expect(latest?.rooms[0]?.updatedAt).toBe('2026-08-28T12:00:00.000Z')
  })

  it('一轮多个工具完成合并为一次重拉', async () => {
    act(() => publishChange())
    act(() => publishChange())
    act(() => publishChange())
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(list).toHaveBeenCalledTimes(1)
    expect(latest?.rooms[0]?.updatedAt).toBe('2026-08-28T12:00:00.000Z')
  })
})
