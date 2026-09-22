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

import type { RoomMail, RoomMailDetail } from '@nxcore/agent-contract'
import type { ReactNode } from 'react'

// 无 DOM 环境：本地邮件详情（ObjectDetailView）内的归入纠正菜单替换为透传。
vi.mock('@radix-ui/react-dropdown-menu', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => children ?? null
  return {
    Root: passthrough,
    Trigger: ({ children }: { children?: ReactNode }) => children ?? null,
    Portal: passthrough,
    Content: passthrough,
    Item: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) => (
      <button type="button" onClick={onSelect}>{children}</button>
    ),
  }
})

import { createContextRoomFixture } from './context-room-fixture'
import type { ContextRoomRecord } from '../src/renderer/src/components/context-room/ported/types'
import type { WorkspaceObjectPreview } from '../src/renderer/src/components/context-room/ported/components/detail-panels'
import { MailPane } from '../src/renderer/src/components/context-room/ported/components/detail-panels/ActivityPanes'

function mailFixture(overrides: Partial<RoomMail> & { sourceId: string; subject: string }): RoomMail {
  return {
    senderName: null,
    senderAddress: null,
    sentAt: null,
    snippet: null,
    hasAttachments: false,
    ...overrides,
  }
}

function localMail(id: string, title: string, time: string, extra: Partial<ContextRoomRecord['materials'][number]> = {}) {
  return { id, type: '邮件' as const, title, time, summary: `${title}摘要`, ...extra }
}

/** 本地“今天”的日期串与 ISO 串（同主题 + 同日触发去重）。 */
function localDateString(): string {
  const now = new Date()
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
}

function todayAtLocal(hour: number): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0).toISOString()
}

function roomWithLocalMails(): ContextRoomRecord {
  const room = createContextRoomFixture('room-todo-mail', '待办邮件 Room')
  room.materials = [
    // 与连接器邮件同主题同日：去重，保留连接器版本
    localMail('lm-dup', '设计周报', `${localDateString()} 10:20`),
    localMail('lm-keep', '预算确认', `${localDateString()} 09:00`, { sender: '财务' }),
    localMail('lm-old', '上周纪要', '2026-01-06 15:00'),
  ]
  return room
}

async function renderMailPane(
  room: ContextRoomRecord,
  mails: RoomMail[] = [],
  mailDetails: Record<string, RoomMailDetail> = {},
  detail: WorkspaceObjectPreview | null = null,
) {
  const listMails = vi.fn().mockResolvedValue({ items: mails })
  const readMail = vi.fn(async (_roomId: string, sourceId: string) => {
    const mailDetail = mailDetails[sourceId]
    if (!mailDetail) throw new Error('mail_not_found')
    return mailDetail
  })
  const onOpen = vi.fn()
  const onCloseDetail = vi.fn()
  vi.stubGlobal('window', {
    ...globalThis,
    nxcore: { contextRooms: { listMails, readMail } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  let renderer: TestRenderer.ReactTestRenderer | null = null
  await act(async () => {
    renderer = TestRenderer.create(
      <MailPane
        room={room}
        onOpen={onOpen}
        detail={detail}
        onCloseDetail={onCloseDetail}
        onUpdateRoom={() => {}}
      />,
    )
  })
  return { renderer: renderer!, onOpen, onCloseDetail, listMails, readMail }
}

function rowTitles(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAll((node) => typeof node.props?.className === 'string'
      && node.props.className.split(' ').includes('context-room-mail-item'))
    .map((node) => node.findByType('b').children[0])
}

describe('待办 / 邮件分区', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('连接器邮件与本地快照合并按时间倒序；同主题同日的本地邮件去重', async () => {
    const { renderer } = await renderMailPane(roomWithLocalMails(), [
      mailFixture({ sourceId: 'cm-1', subject: '设计周报', senderName: '林薇', sentAt: todayAtLocal(10) }),
    ])
    expect(rowTitles(renderer)).toEqual(['设计周报', '预算确认', '上周纪要'])
  })

  it('点击连接器邮件行派发 connector-mail 对象；本地邮件行派发 mail 对象', async () => {
    const room = roomWithLocalMails()
    const { renderer, onOpen } = await renderMailPane(room, [
      mailFixture({ sourceId: 'cm-1', subject: '设计周报', sentAt: todayAtLocal(10) }),
    ])
    const rows = renderer.root.findAll((node) => typeof node.props?.className === 'string'
      && node.props.className.split(' ').includes('context-room-mail-item'))
    await act(async () => {
      rows[0].props.onClick()
      rows[1].props.onClick()
    })
    expect(onOpen).toHaveBeenNthCalledWith(1, { kind: 'connector-mail', sourceId: 'cm-1' })
    expect(onOpen).toHaveBeenNthCalledWith(2, { kind: 'mail', id: 'lm-keep' })
  })

  it('连接器邮件详情整区替换：拉取正文后显示主题，关闭回调可用', async () => {
    const mailDetail = {
      sourceId: 'cm-1',
      provider: null,
      subject: '设计周报',
      senderName: '林薇',
      senderAddress: 'linwei@example.com',
      sentAt: todayAtLocal(10),
      body: '本周完成了视觉走查',
      hasAttachments: false,
    } as unknown as RoomMailDetail
    const { renderer, readMail, onCloseDetail } = await renderMailPane(
      roomWithLocalMails(),
      [mailFixture({ sourceId: 'cm-1', subject: '设计周报', sentAt: todayAtLocal(10) })],
      { 'cm-1': mailDetail },
      { kind: 'connector-mail', sourceId: 'cm-1' },
    )
    expect(readMail).toHaveBeenCalledWith('room-todo-mail', 'cm-1')
    const detail = renderer.root.findAll((node) =>
      typeof node.props?.['data-testid'] === 'string'
      && node.props['data-testid'] === 'context-room-mail-detail')
    expect(detail).toHaveLength(1)
    expect(renderer.root.findByProps({ title: '设计周报' }).children.join('')).toContain('设计周报')
    const close = renderer.root.findAllByType('button')
      .find((button) => button.props['aria-label'] === '关闭邮件详情')
    expect(close).toBeTruthy()
    await act(async () => {
      close!.props.onClick()
    })
    expect(onCloseDetail).toHaveBeenCalledTimes(1)
  })

  it('无邮件时空态不渲染行', async () => {
    const { renderer } = await renderMailPane(createContextRoomFixture('room-todo-mail', '待办邮件 Room'))
    expect(rowTitles(renderer)).toEqual([])
    expect(renderer.root.findAll((node) => typeof node.props?.className === 'string'
      && node.props.className.split(' ').includes('context-room-mail-item'))).toHaveLength(0)
  })
})
