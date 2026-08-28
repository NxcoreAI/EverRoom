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

import type { RoomMail } from '@nxcore/agent-contract'

import { createContextRoomFixture } from './context-room-fixture'
import { MailsPane } from '../src/renderer/src/components/context-room/ported/components/detail-panels/ActivityPanes'

/** 本地“今天”的 ISO 串（与本地快照同日时才触发「主题 + 同日」去重）。 */
function todayAtLocal(hour: number): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0).toISOString()
}

function localDateString(): string {
  const now = new Date()
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
}

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

async function renderMailsPane(
  room = createContextRoomFixture('room-mail', '邮件 Room'),
  mails: RoomMail[] = [],
) {
  const listMails = vi.fn().mockResolvedValue({ items: mails })
  vi.stubGlobal('window', {
    ...globalThis,
    nxcore: { contextRooms: { listMails } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  let renderer: TestRenderer.ReactTestRenderer | null = null
  await act(async () => {
    renderer = TestRenderer.create(
      <MailsPane room={room} onSelect={() => {}} onUpdateRoom={() => {}} />,
    )
  })
  return { renderer: renderer!, listMails }
}

/** 邮件行（popover 触发器或本地行）：以标题 <strong> 与来源标记定位。 */
function mailTitles(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAll((node) => typeof node.props?.className === 'string'
      && node.props.className.split(' ').includes('context-room-mail-pane'))
    .flatMap((pane) => pane.findAllByType('strong'))
    .map((node) => node.children[0])
}

function connectorMailButtons(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll((node) => node.props?.['data-connector-source'] === 'mail')
}

/** header 里 h2 旁的计数 <span>。 */
function headerCount(renderer: TestRenderer.ReactTestRenderer) {
  const pane = renderer.root.findAll((node) => typeof node.props?.className === 'string'
    && node.props.className.split(' ').includes('context-room-mail-pane'))[0]
  const header = pane.findByType('header')
  return header.findAllByType('span')[0].children[0]
}

describe('邮箱面板：连接器邮件叠加', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('连接器邮件渲染进面板（主题/发件人/摘要/时间），计数含连接器条数', async () => {
    const { renderer, listMails } = await renderMailsPane(undefined, [
      mailFixture({
        sourceId: 'mail-1', subject: '发射窗口确认',
        senderName: '李四', senderAddress: 'li@example.com',
        sentAt: todayAtLocal(9), snippet: '请确认 9 月 5 日的发射窗口。',
      }),
      mailFixture({
        sourceId: 'mail-2', subject: '周报',
        senderAddress: 'zhang@example.com', sentAt: todayAtLocal(8), snippet: '本周进展顺利。',
      }),
    ])
    expect(listMails).toHaveBeenCalledWith('room-mail')
    expect(mailTitles(renderer)).toEqual(['发射窗口确认', '周报'])
    expect(headerCount(renderer)).toBe('2')
    const buttons = connectorMailButtons(renderer)
    expect(buttons.map((node) => node.findByType('b').children[0])).toEqual(['李四', 'zhang@example.com'])
    expect(buttons[0].findByType('small').children[0]).toBe('请确认 9 月 5 日的发射窗口。')
    expect(buttons[0].findByType('time').children[0]).toBeTruthy()
  })

  it('与连接器邮件同主题同日的 LLM 快照去重（保留连接器版本），不同主题的本地邮件保留', async () => {
    const room = createContextRoomFixture('room-mail', '邮件 Room')
    room.materials = [
      { id: 'mail-llm', type: '邮件', title: '发射窗口确认', time: `${localDateString()} 09:30`, summary: 'LLM 快照里的同一封邮件' },
      { id: 'mail-local', type: '邮件', title: '本地另一封邮件', time: `${localDateString()} 14:00`, summary: '不重复的本地邮件' },
    ]
    const { renderer } = await renderMailsPane(room, [
      mailFixture({
        sourceId: 'mail-1', subject: '发射窗口确认',
        senderName: '李四', sentAt: todayAtLocal(10), snippet: '连接器版本',
      }),
    ])
    // 本地在前、连接器在后；快照版「发射窗口确认」被连接器版本顶掉
    expect(mailTitles(renderer)).toEqual(['本地另一封邮件', '发射窗口确认'])
    expect(headerCount(renderer)).toBe('2')
    expect(connectorMailButtons(renderer)).toHaveLength(1)
  })

  it('邮件端点不可用时回落本地快照（不渲染连接器条目）', async () => {
    const room = createContextRoomFixture('room-mail', '邮件 Room')
    room.materials = [
      { id: 'mail-local', type: '邮件', title: '本地邮件', time: `${localDateString()} 10:00`, summary: '仅本地' },
    ]
    const listMails = vi.fn().mockRejectedValue(new Error('mails unavailable'))
    vi.stubGlobal('window', {
      ...globalThis,
      nxcore: { contextRooms: { listMails } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = TestRenderer.create(
        <MailsPane room={room} onSelect={() => {}} onUpdateRoom={() => {}} />,
      )
    })
    expect(mailTitles(renderer!)).toEqual(['本地邮件'])
    expect(connectorMailButtons(renderer!)).toHaveLength(0)
    expect(headerCount(renderer!)).toBe('1')
  })
})
