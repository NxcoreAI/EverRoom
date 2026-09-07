// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadRoomFocus, saveRoomFocus } from './roomFocusStore'

describe('roomFocusStore', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it('persists and restores each room independently', () => {
    expect(loadRoomFocus('room-a')).toBe(false)
    saveRoomFocus('room-a', true)
    saveRoomFocus('room-b', false)
    expect(loadRoomFocus('room-a')).toBe(true)
    expect(loadRoomFocus('room-b')).toBe(false)
    // 关闭后清除该房间的持久项，不影响其他房间。
    saveRoomFocus('room-a', false)
    expect(loadRoomFocus('room-a')).toBe(false)
    saveRoomFocus('room-b', true)
    expect(loadRoomFocus('room-b')).toBe(true)
  })

  it('degrades to disabled on corrupt or unexpected storage payloads', () => {
    window.localStorage.setItem('nexcore:agent:room-focus:v1', 'not-json')
    expect(loadRoomFocus('room-a')).toBe(false)
    window.localStorage.setItem('nexcore:agent:room-focus:v1', JSON.stringify('string-payload'))
    expect(loadRoomFocus('room-a')).toBe(false)
    window.localStorage.setItem('nexcore:agent:room-focus:v1', JSON.stringify({ 'room-a': 'yes' }))
    expect(loadRoomFocus('room-a')).toBe(false)
  })

  it('keeps working without throwing when storage is unavailable', () => {
    const failing = window.localStorage
    vi.spyOn(failing, 'getItem').mockImplementation(() => { throw new Error('quota') })
    vi.spyOn(failing, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => saveRoomFocus('room-a', true)).not.toThrow()
    expect(loadRoomFocus('room-a')).toBe(false)
    vi.restoreAllMocks()
  })
})
