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

// 无 DOM 环境：资料行尾的归入纠正菜单（Radix DropdownMenu）替换为透传，
// 本文件只测来源对象行本身；纠正流程在 context-room-resource-correction.test.tsx 覆盖。
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
import { MaterialsPane } from '../src/renderer/src/components/context-room/ported/components/detail-panels/MaterialsPane'

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

async function renderMaterialsPane(
  room = createContextRoomFixture('room-mail', '邮件 Room'),
  mails: RoomMail[] = [],
  mailDetails: Record<string, RoomMailDetail> = {},
  detail: { kind: 'connector-mail'; sourceId: string } | null = null,
) {
  const listMails = vi.fn().mockResolvedValue({ items: mails })
  const readMail = vi.fn(async (_roomId: string, sourceId: string) => {
    const detail = mailDetails[sourceId]
    if (!detail) throw new Error('mail_not_found')
    return detail
  })
  vi.stubGlobal('window', {
    ...globalThis,
    nxcore: { contextRooms: { listMails, readMail } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  let renderer: TestRenderer.ReactTestRenderer | null = null
  await act(async () => {
    renderer = TestRenderer.create(
      <MaterialsPane
        room={room}
        rooms={[]}
        backendDocuments={[]}
        trashedDocuments={[]}
        knowledgeFiles={[]}
        selectedId={null}
        onSelect={() => {}}
        onDeleteDocument={vi.fn()}
        onRestoreDocument={vi.fn()}
        onDeleteDocumentPermanently={vi.fn()}
        onEmptyTrash={vi.fn()}
        onOpenObject={() => {}}
        detail={detail}
        onCloseDetail={() => {}}
        onUpdateRoom={() => {}}
      />,
    )
  })
  return { renderer: renderer!, listMails, readMail }
}

/** 资料行的标题 <b>（来源对象平铺后邮件不再有独立面板计数）。 */
function rowTitles(renderer: TestRenderer.ReactTestRenderer, rowType?: string) {
  return renderer.root
    .findAll((node) => typeof node.props?.className === 'string'
      && node.props.className.split(' ').includes('context-room-materials-row')
      && (rowType ? node.props['data-row-type'] === rowType : true))
    .map((node) => node.findByType('b').children[0])
}

function connectorMailRows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll((node) => node.props?.['data-connector-source'] === 'mail')
}

describe('资料面板：邮件作为来源对象平铺', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('连接器邮件渲染进资料平铺（主题/发件人/摘要/时间），与文件文档同列', async () => {
    const { renderer, listMails } = await renderMaterialsPane(undefined, [
      mailFixture({
        sourceId: 'mail-1', subject: '发射窗口确认', provider: 'gmail',
        senderName: '李四', senderAddress: 'li@example.com',
        sentAt: todayAtLocal(9), snippet: '请确认 9 月 5 日的发射窗口。',
      }),
      mailFixture({
        sourceId: 'mail-2', subject: '周报', provider: 'outlook',
        senderAddress: 'zhang@example.com', sentAt: todayAtLocal(8), snippet: '本周进展顺利。',
      }),
    ])
    expect(listMails).toHaveBeenCalledWith('room-mail')
    expect(rowTitles(renderer, 'mail')).toEqual(['发射窗口确认', '周报'])
    const rows = connectorMailRows(renderer)
    expect(rows.map((node) => node.findByType('b').children[0])).toEqual(['发射窗口确认', '周报'])
    expect(rows[0].findByType('small').children[0]).toBe('李四')
    expect(rows[0].findByType('time').children[0]).toBeTruthy()
    // 数据源品牌图标：gmail/outlook 用各自品牌标（vite 对小 svg 内联 data URI、大的保留文件 URL）
    const iconSrc = (node: TestRenderer.ReactTestInstance) => {
      const img = node.findAllByType('img')[0]
      return img ? String(img.props.src) : ''
    }
    expect(iconSrc(rows[0])).toContain('%234285f4')
    expect(iconSrc(rows[1])).toContain('outlook')
    expect(iconSrc(rows[1])).not.toBe(iconSrc(rows[0]))
  })

  it('未登记 provider 与本地快照邮件回退通用邮件图标（不渲染品牌 img）', async () => {
    const room = createContextRoomFixture('room-mail', '邮件 Room')
    room.materials = [
      { id: 'mail-local', type: '邮件', title: '本地快照邮件', time: `${localDateString()} 10:00`, summary: '无 provider' },
    ]
    const { renderer } = await renderMaterialsPane(room, [
      mailFixture({
        sourceId: 'mail-qq', subject: '未登记服务商邮件', provider: 'qq-mail',
        senderAddress: 'noreply@qq.example', sentAt: todayAtLocal(9), snippet: '预留下来的扩展位。',
      }),
      mailFixture({
        sourceId: 'mail-unknown', subject: '无服务商邮件', provider: null,
        senderAddress: 'noreply@unknown', sentAt: todayAtLocal(8), snippet: 'provider 为 null。',
      }),
    ])
    const rows = connectorMailRows(renderer)
    expect(rowTitles(renderer, 'mail')).toEqual(['本地快照邮件', '未登记服务商邮件', '无服务商邮件'])
    // 连接器行均回退 lucide Mail（无 img），本地行本来就是通用图标
    for (const row of rows) expect(row.findAllByType('img')).toHaveLength(0)
  })

  it('与连接器邮件同主题同日的 LLM 快照去重（保留连接器版本），不同主题的本地邮件保留', async () => {
    const room = createContextRoomFixture('room-mail', '邮件 Room')
    room.materials = [
      { id: 'mail-llm', type: '邮件', title: '发射窗口确认', time: `${localDateString()} 09:30`, summary: 'LLM 快照里的同一封邮件' },
      { id: 'mail-local', type: '邮件', title: '本地另一封邮件', time: `${localDateString()} 14:00`, summary: '不重复的本地邮件' },
    ]
    const { renderer } = await renderMaterialsPane(room, [
      mailFixture({
        sourceId: 'mail-1', subject: '发射窗口确认',
        senderName: '李四', sentAt: todayAtLocal(10), snippet: '连接器版本',
      }),
    ])
    // 按来源时间倒序：本地 14:00 > 连接器 10:00；快照版「发射窗口确认」被连接器版本顶掉
    expect(rowTitles(renderer, 'mail')).toEqual(['本地另一封邮件', '发射窗口确认'])
    expect(connectorMailRows(renderer)).toHaveLength(1)
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
        <MaterialsPane
          room={room}
          rooms={[]}
          backendDocuments={[]}
          trashedDocuments={[]}
          knowledgeFiles={[]}
          selectedId={null}
          onSelect={() => {}}
          onDeleteDocument={vi.fn()}
          onRestoreDocument={vi.fn()}
          onDeleteDocumentPermanently={vi.fn()}
          onEmptyTrash={vi.fn()}
          onOpenObject={() => {}}
          onCloseDetail={() => {}}
          onUpdateRoom={() => {}}
        />,
      )
    })
    expect(rowTitles(renderer!, 'mail')).toEqual(['本地邮件'])
    expect(connectorMailRows(renderer!)).toHaveLength(0)
  })

  it('点击连接器邮件行派发 connector-mail 详情对象；受控详情拉取正文并可关闭', async () => {
    const details: Record<string, RoomMailDetail> = {
      'mail-1': {
        sourceId: 'mail-1', subject: '发射窗口确认', senderName: '李四', senderAddress: 'li@example.com',
        sentAt: todayAtLocal(9), hasAttachments: true, provider: 'gmail', origin: 'domain',
        body: '请确认 9 月 5 日的发射窗口。\n\n此致',
      },
    }
    const listMails = vi.fn().mockResolvedValue({ items: [mailFixture({ sourceId: 'mail-1', subject: '发射窗口确认', provider: 'gmail', senderName: '李四', sentAt: todayAtLocal(9), snippet: '请确认…' })] })
    const readMail = vi.fn(async () => details['mail-1'])
    vi.stubGlobal('window', {
      ...globalThis,
      nxcore: { contextRooms: { listMails, readMail } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const onOpenObject = vi.fn()
    const onCloseDetail = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer | null = null
    const element = (detail: { kind: 'connector-mail'; sourceId: string } | null) => (
        <MaterialsPane
          room={createContextRoomFixture('room-mail', '邮件 Room')}
          rooms={[]}
          backendDocuments={[]}
          trashedDocuments={[]}
          knowledgeFiles={[]}
          selectedId={null}
          onSelect={() => {}}
          onDeleteDocument={vi.fn()}
          onRestoreDocument={vi.fn()}
          onDeleteDocumentPermanently={vi.fn()}
          onEmptyTrash={vi.fn()}
          onOpenObject={onOpenObject}
          detail={detail}
          onCloseDetail={onCloseDetail}
          onUpdateRoom={() => {}}
        />
    )
    const render = (detail: { kind: 'connector-mail'; sourceId: string } | null) => {
      // 同一实例上 update（真实链路面板不卸载，缓存跨详情切换保留）
      if (renderer) renderer.update(element(detail))
      else renderer = TestRenderer.create(element(detail))
    }
    await act(async () => { render(null) })
    expect(renderer!.root.findAllByProps({ 'data-testid': 'context-room-mail-detail' })).toHaveLength(0)

    // 行点击派发受控详情对象（真实链路由 PortedDetail 保存并回传）
    const row = connectorMailRows(renderer!)[0]
    await act(async () => { row.findAllByType('button')[0].props.onClick() })
    expect(onOpenObject).toHaveBeenCalledWith({ kind: 'connector-mail', sourceId: 'mail-1' })

    // 受控详情到达：拉取正文渲染下半区
    await act(async () => { render({ kind: 'connector-mail', sourceId: 'mail-1' }) })
    expect(readMail).toHaveBeenCalledWith('room-mail', 'mail-1')
    const detailPane = renderer!.root.findByProps({ 'data-testid': 'context-room-mail-detail' })
    expect(JSON.stringify(renderer!.toJSON())).toContain('请确认 9 月 5 日的发射窗口。')

    // 关闭按钮派发 onCloseDetail（受控态收起）
    act(() => { detailPane.findByProps({ 'aria-label': '关闭邮件详情' }).props.onClick() })
    expect(onCloseDetail).toHaveBeenCalledTimes(1)

    // 同一封再次进入走会话缓存（不重复请求）
    await act(async () => { render(null) })
    await act(async () => { render({ kind: 'connector-mail', sourceId: 'mail-1' }) })
    expect(readMail).toHaveBeenCalledTimes(1)
  })

  it('详情拉取失败：下半区显示正文暂不可用，面板不崩溃', async () => {
    const { renderer } = await renderMaterialsPane(undefined, [
      mailFixture({ sourceId: 'mail-x', subject: '失效邮件', sentAt: todayAtLocal(9), snippet: 'x' }),
    ], {}, { kind: 'connector-mail', sourceId: 'mail-x' })
    expect(renderer.root.findAllByProps({ 'data-testid': 'context-room-mail-detail' })).toHaveLength(1)
    expect(JSON.stringify(renderer.toJSON())).toContain('邮件正文暂不可用')
  })
})

describe('资料面板：按来源对象排序与按 Room 记忆', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function renderSortPane(storage: Map<string, string>) {
    vi.stubGlobal('window', {
      ...globalThis,
      nxcore: { contextRooms: { listMails: vi.fn().mockResolvedValue({ items: [] }) } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value) },
        removeItem: (key: string) => { storage.delete(key) },
      },
    })
    const room = createContextRoomFixture('room-sort', '排序 Room')
    room.materials = [
      { id: 'meeting-1', type: '会议', title: 'C 评审会', time: `${localDateString()} 08:00`, summary: '' },
    ]
    const backendDocuments = [{
      id: 'doc-1', roomId: 'room-sort', title: 'B 文档',
      contentJson: { type: 'doc', content: [] }, contentSchemaVersion: 1, version: 1,
      status: 'active' as const, activeTransactionId: null,
      createdAt: todayAtLocal(10), updatedAt: todayAtLocal(10),
    }]
    const knowledgeFiles = [{
      id: 'file-1', roomId: 'room-sort', originalName: 'A 文件.md', bytes: 2048,
      uploadedAt: todayAtLocal(9), status: 'ready',
    }]
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = TestRenderer.create(
        <MaterialsPane
          room={room}
          rooms={[]}
          backendDocuments={backendDocuments}
          trashedDocuments={[]}
          knowledgeFiles={knowledgeFiles as unknown as Parameters<typeof MaterialsPane>[0]['knowledgeFiles']}
          selectedId={null}
          onSelect={() => {}}
          onDeleteDocument={vi.fn()}
          onRestoreDocument={vi.fn()}
          onDeleteDocumentPermanently={vi.fn()}
          onEmptyTrash={vi.fn()}
          onOpenObject={() => {}}
          onCloseDetail={() => {}}
          onUpdateRoom={() => {}}
        />,
      )
    })
    return { renderer: renderer!, storage }
  }

  it('默认按来源时间倒序平铺（不按格式分夹），导入时间在行内标明', async () => {
    const { renderer } = await renderSortPane(new Map())
    expect(rowTitles(renderer)).toEqual(['B 文档', 'A 文件.md', 'C 评审会'])
    // 上传文件缺来源创建时间 → 用导入时间并标明依据（PRD 6.6）
    const times = renderer.root.findAllByType('time').map((node) => node.children.join(''))
    expect(times.every((text) => text.includes('导入于') || text.length > 0)).toBe(true)
    expect(times[0]).toContain('导入于')
    expect(times[1]).toContain('导入于')
  })

  it('切换排序按 Room 记忆（localStorage），下次进入恢复', async () => {
    const storage = new Map<string, string>()
    const { renderer } = await renderSortPane(storage)
    // 切到名称排序（原型资料工具栏的两态排序切换按钮）
    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '切换排序' }).props.onClick()
    })
    expect(rowTitles(renderer)).toEqual(['A 文件.md', 'B 文档', 'C 评审会'])
    expect(storage.get('nxcore-ce:room-materials-view:v1')).toContain('"sort":"name"')
    // 重新进入（新实例 + 已记忆的 storage）：恢复名称排序
    const second = await renderSortPane(storage)
    expect(rowTitles(second.renderer)).toEqual(['A 文件.md', 'B 文档', 'C 评审会'])
  })
})
