import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import { createContextRoomFixture } from './context-room-fixture'
import { MailsPane, TasksPane } from '../src/renderer/src/components/context-room/ported/components/detail-panels/ActivityPanes'

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

function flattenChildren(node: TestRenderer.ReactTestInstance): string {
  return node.children.flatMap((child) => (typeof child === 'string' ? [child] : [])).join('')
}

function textNodes(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root.findAll((node) => (
    typeof node.children === 'string' || Array.isArray(node.children)
      ? flattenChildren(node).includes(text)
      : false
  ))
}

function roomWithObjects() {
  const room = createContextRoomFixture()
  room.actionItems = [{
    id: 'task-1',
    title: '补齐 OAuth 文档',
    status: '进行中',
    owner: 'AI 助手',
    completed: false,
    deadline: '今天',
    source: null,
  }]
  room.materials = [{
    id: 'mail-1',
    type: '邮件',
    title: 'Nango 授权异常告警',
    time: '2026-08-27 09:30',
    sender: 'ops@example.com',
    recipient: null,
    folder: 'inbox',
    unread: true,
    summary: 'Pre-built authorization 连接失败',
    body: null,
    attachments: [],
  }]
  return room
}

describe('pane-embedded object detail', () => {
  it('renders the task detail inside the tasks pane and reports back on close', async () => {
    const room = roomWithObjects()
    const closeDetail = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <TasksPane
          room={room}
          onSelect={() => undefined}
          onToggle={() => undefined}
          detail={{ kind: 'task', id: 'task-1' }}
          onCloseDetail={closeDetail}
          onUpdateRoom={() => undefined}
        />,
      )
    })
    // 详情子视图替换列表：任务详情页在场，任务列表不在场。
    expect(renderer!.root.findAllByProps({ 'data-testid': 'context-room-task-reference' })).toHaveLength(1)
    expect(textNodes(renderer!, '补齐 OAuth 文档')).not.toHaveLength(0)
    expect(renderer!.root.findAllByProps({ className: 'context-room-task-pane' })).toHaveLength(0)

    const back = renderer!.root.findAllByProps({ className: 'context-room-ghost context-room-small context-room-object-back' })[0]
    expect(back).toBeTruthy()
    await act(async () => {
      back!.props.onClick()
    })
    expect(closeDetail).toHaveBeenCalledTimes(1)
  })

  it('renders the mail detail inside the mails pane instead of a dialog', async () => {
    const room = roomWithObjects()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <MailsPane
          room={room}
          onSelect={() => undefined}
          detail={{ kind: 'mail', id: 'mail-1' }}
          onCloseDetail={() => undefined}
          onUpdateRoom={() => undefined}
        />,
      )
    })
    expect(textNodes(renderer!, 'Nango 授权异常告警')).not.toHaveLength(0)
    expect(renderer!.root.findAllByProps({ className: 'context-room-mail-pane' })).toHaveLength(0)
  })

  it('falls back to the pane list when the detail object no longer exists', async () => {
    const room = roomWithObjects()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <TasksPane
          room={room}
          onSelect={() => undefined}
          onToggle={() => undefined}
          detail={{ kind: 'task', id: 'task-gone' }}
          onCloseDetail={() => undefined}
          onUpdateRoom={() => undefined}
        />,
      )
    })
    expect(renderer!.root.findAllByProps({ className: 'context-room-task-pane' })).toHaveLength(1)
  })
})
