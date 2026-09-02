import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) =>
        actual.translate('zh-CN', message, values),
      locale: 'zh-CN',
    }),
  }
})

import {
  RoomMergePartnerPicker,
  type MergePartnerOption,
} from '../src/renderer/src/components/context-room/ported/components/RoomMergePartnerPicker'

const rooms: MergePartnerOption[] = [
  { id: 'room-origin', title: '当前 Room', kind: '项目' },
  { id: 'room-campus', title: '校园生活', kind: '主题' },
  { id: 'room-java', title: 'Java Space', kind: '主题' },
]

function listTitles(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType('b').map((node) => node.children.join(''))
}

describe('RoomMergePartnerPicker', () => {
  it('lists rooms excluding the origin and reports the clicked pick', async () => {
    const onChange = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <RoomMergePartnerPicker rooms={rooms} excludeRoomId="room-origin" value="" onChange={onChange} />,
      )
    })
    expect(listTitles(renderer!)).toEqual(['校园生活', 'Java Space'])

    await act(async () => {
      renderer!.root.findAllByType('button')[0]!.props.onClick()
    })
    expect(onChange).toHaveBeenCalledWith('room-campus')
  })

  it('filters by title case-insensitively and shows an empty state without matches', async () => {
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <RoomMergePartnerPicker rooms={rooms} excludeRoomId="room-origin" value="" onChange={() => undefined} />,
      )
    })
    await act(async () => {
      renderer!.root.findByType('input').props.onChange({ target: { value: 'JAVA' } })
    })
    expect(listTitles(renderer!)).toEqual(['Java Space'])

    await act(async () => {
      renderer!.root.findByType('input').props.onChange({ target: { value: '不存在的房间' } })
    })
    expect(renderer!.root.findAllByType('button')).toHaveLength(0)
    expect(renderer!.root.findAllByType('p')[0]!.children.join('')).toBe('没有匹配的 Room')
  })

  it('picks the first match on Enter when nothing is selected', async () => {
    const onChange = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <RoomMergePartnerPicker rooms={rooms} excludeRoomId="room-origin" value="" onChange={onChange} />,
      )
    })
    await act(async () => {
      renderer!.root.findByType('input').props.onChange({ target: { value: 'space' } })
    })
    await act(async () => {
      renderer!.root.findByType('input').props.onKeyDown({ key: 'Enter' })
    })
    expect(onChange).toHaveBeenCalledWith('room-java')

    // 已有有效选择时回车不覆盖。
    onChange.mockClear()
    await act(async () => {
      renderer!.update(
        <RoomMergePartnerPicker rooms={rooms} excludeRoomId="room-origin" value="room-java" onChange={onChange} />,
      )
    })
    await act(async () => {
      renderer!.root.findByType('input').props.onKeyDown({ key: 'Enter' })
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})
