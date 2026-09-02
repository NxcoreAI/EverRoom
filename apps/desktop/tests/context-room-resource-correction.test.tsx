import TestRenderer, { act } from 'react-test-renderer'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

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

// 无 DOM 环境：Radix 下拉与 ReferenceDialog 替换为透传容器，只测状态机。
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
vi.mock('../src/renderer/src/components/context-room/ported/components/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/context-room/ported/components/shared')>()
  return {
    ...actual,
    ReferenceDialog: function MockReferenceDialog({ open, children }: { open: boolean; children?: ReactNode }) {
      return open ? <div>{children}</div> : null
    },
  }
})

import { ResourceCorrectionMenu } from '../src/renderer/src/components/context-room/ported/components/ResourceCorrection'
import { UnmatchedDocsSection } from '../src/renderer/src/components/context-room/ported/components/UnmatchedDocsSection'
import { createContextRoomFixture } from './context-room-fixture'

type KnowledgeApi = {
  listRecentDecisions: ReturnType<typeof vi.fn>
  revertDecision: ReturnType<typeof vi.fn>
  listEntities: ReturnType<typeof vi.fn>
  attachDoc: ReturnType<typeof vi.fn>
  listUnmatched: ReturnType<typeof vi.fn>
}

function installKnowledgeApi(overrides: Partial<Record<keyof KnowledgeApi, ReturnType<typeof vi.fn>>>): KnowledgeApi {
  const api: KnowledgeApi = {
    listRecentDecisions: vi.fn(async () => ({ items: [] })),
    revertDecision: vi.fn(async () => ({ ok: true })),
    listEntities: vi.fn(async () => ({ items: [] })),
    attachDoc: vi.fn(async () => ({ entityId: 'entity-1' })),
    listUnmatched: vi.fn(async () => ({ items: [] })),
    ...overrides,
  }
  ;(globalThis as { window?: unknown }).window = {
    nxcore: { knowledge: api },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }
  return api
}

/** 按钮全文（含 <b>/<small> 嵌套文本）。 */
function buttonText(node: TestRenderer.ReactTestInstance): string {
  const parts: string[] = []
  const walk = (current: { children?: unknown[] }) => {
    for (const child of current.children ?? []) {
      if (typeof child === 'string') parts.push(child)
      else if (child && typeof child === 'object' && Array.isArray((child as { children?: unknown[] }).children)) {
        walk(child as { children?: unknown[] })
      }
    }
  }
  walk(node)
  return parts.join('')
}

function clickByText(renderer: TestRenderer.ReactTestRenderer, text: string, exact = false) {
  const node = renderer.root
    .findAll((item) => item.type === 'button')
    .find((button) => {
      const full = buttonText(button)
      return exact ? full.trim() === text : full.includes(text)
    })
  expect(node, `button containing "${text}"`).toBeTruthy()
  return node!
}

describe('ResourceCorrectionMenu（资料归入纠正）', () => {
  const room = createContextRoomFixture('room-a', '当前 Room')
  const rooms = [
    room,
    createContextRoomFixture('room-b', '目标 Room'),
    createContextRoomFixture('room-c', '无实体 Room'),
  ]

  it('移出本 Room：按 sourceKind+sourceId 反查决策并 revert，派发 knowledge-changed', async () => {
    const api = installKnowledgeApi({
      listRecentDecisions: vi.fn(async () => ({
        items: [
          { decisionId: 'd-other', sourceKind: 'mail', sourceId: 'm1', roomId: 'room-a', roomTitle: '当前 Room', title: '别的资料', decidedBy: 'resolution', confidence: 0.9, reason: null, status: 'confirmed', createdAt: '2026-09-02T00:00:00.000Z' },
          { decisionId: 'd-file', sourceKind: 'file', sourceId: 'file-1', roomId: 'room-a', roomTitle: '当前 Room', title: '会议纪要.md', decidedBy: 'resolution', confidence: 0.9, reason: null, status: 'confirmed', createdAt: '2026-09-02T00:00:00.000Z' },
        ],
      })),
    })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <ResourceCorrectionMenu
          room={room}
          rooms={rooms}
          target={{ sourceKind: 'file', sourceId: 'file-1', title: '会议纪要.md' }}
        />,
      )
    })
    await act(async () => {
      clickByText(renderer!, '移出本 Room').props.onClick()
    })
    expect(api.revertDecision).toHaveBeenCalledWith('d-file')
  })

  it('改归其他 Room：选择目标后 attach 到其户口实体', async () => {
    const api = installKnowledgeApi({
      listEntities: vi.fn(async (status: string) => ({
        items: status === 'room'
          ? [{ id: 'entity-b', name: '目标', kind: '主题', status: 'room', roomId: 'room-b', evidenceScore: 3, sourceCount: 3, updatedAt: '2026-09-02T00:00:00.000Z' }]
          : { items: [] },
      })),
    })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <ResourceCorrectionMenu
          room={room}
          rooms={rooms}
          target={{ sourceKind: 'mail', sourceId: 'mail-1', title: '周报' }}
        />,
      )
    })
    await act(async () => {
      clickByText(renderer!, '改归其他 Room…').props.onClick()
    })
    // 伙伴选择器列出除当前 Room 外的目标
    await act(async () => {
      clickByText(renderer!, '目标 Room').props.onClick()
    })
    await act(async () => {
      clickByText(renderer!, '改归', true).props.onClick()
    })
    expect(api.attachDoc).toHaveBeenCalledWith('mail', 'mail-1', { entityId: 'entity-b' })
  })

  it('目标 Room 无户口实体时报错，不调用 attach', async () => {
    const api = installKnowledgeApi()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <ResourceCorrectionMenu
          room={room}
          rooms={rooms}
          target={{ sourceKind: 'file', sourceId: 'file-1', title: '资料' }}
        />,
      )
    })
    await act(async () => {
      clickByText(renderer!, '改归其他 Room…').props.onClick()
    })
    await act(async () => {
      clickByText(renderer!, '无实体 Room').props.onClick()
    })
    await act(async () => {
      clickByText(renderer!, '改归', true).props.onClick()
    })
    expect(api.attachDoc).not.toHaveBeenCalled()
    expect(renderer!.root.findAll((node) => node.type === 'p' && node.props.role === 'alert')).toHaveLength(1)
  })
})

describe('UnmatchedDocsSection（未识别资料处置）', () => {
  it('列出待挂载资料；选择既有实体挂载', async () => {
    const api = installKnowledgeApi({
      listUnmatched: vi.fn(async () => ({
        items: [
          { decisionId: 'd-1', sourceKind: 'file', sourceId: 'u-file-1', title: '扫描件.pdf', summary: null, reason: '抽取为空', createdAt: '2026-09-02T00:00:00.000Z' },
        ],
      })),
      listEntities: vi.fn(async (status: string) => ({
        items: status === 'weak'
          ? [{ id: 'entity-w', name: '弱实体', kind: '主题', status: 'weak', roomId: null, evidenceScore: 0.5, sourceCount: 1, updatedAt: '2026-09-02T00:00:00.000Z' }]
          : [],
      })),
    })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<UnmatchedDocsSection />)
    })
    expect(renderer!.root.findAll((node) => node.type === 'summary')
      .some((node) => buttonText(node).includes('待挂载资料'))).toBe(true)
    await act(async () => {
      clickByText(renderer!, '挂载到实体…').props.onClick()
    })
    await act(async () => {
      clickByText(renderer!, '弱实体').props.onClick()
    })
    await act(async () => {
      clickByText(renderer!, '挂载', true).props.onClick()
    })
    expect(api.attachDoc).toHaveBeenCalledWith('file', 'u-file-1', { entityId: 'entity-w' })
  })

  it('无匹配实体时可就地新建实体挂载', async () => {
    const api = installKnowledgeApi({
      listUnmatched: vi.fn(async () => ({
        items: [
          { decisionId: 'd-2', sourceKind: 'file', sourceId: 'u-file-2', title: '草稿.md', summary: null, reason: null, createdAt: '2026-09-02T00:00:00.000Z' },
        ],
      })),
    })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<UnmatchedDocsSection />)
    })
    await act(async () => {
      clickByText(renderer!, '挂载到实体…').props.onClick()
    })
    const input = renderer!.root.findByType('input')
    await act(async () => {
      input.props.onChange({ target: { value: '新主题' } })
    })
    await act(async () => {
      clickByText(renderer!, '新建实体「新主题」').props.onClick()
    })
    expect(api.attachDoc).toHaveBeenCalledWith('file', 'u-file-2', {
      createEntity: { name: '新主题', kind: '主题' },
    })
  })
})
