import TestRenderer, { act } from 'react-test-renderer'
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

import type { KnowledgeRoomRelationDto } from '../src/shared/knowledge'

import { createContextRoomFixture } from './context-room-fixture'
import type { ContextRoomResource } from '../src/renderer/src/components/context-room/ported/types'
import { RoomRelationInspector } from '../src/renderer/src/components/context-room/ported/components/RoomRelationControls'

const docResource = {
  id: 'res-doc-1',
  roomId: 'room-test',
  folderId: null,
  name: '评审纪要',
  updatedAt: '2026-08-20T08:00:00.000Z',
  kind: 'cloud-doc',
  binding: { docId: 'doc-1' },
} as unknown as ContextRoomResource

const fileResource = {
  id: 'res-file-1',
  roomId: 'room-test',
  folderId: null,
  name: '需求原文.md',
  updatedAt: '2026-08-19T08:00:00.000Z',
  kind: 'knowledge-file',
  fileId: 'file-1',
} as unknown as ContextRoomResource

function relationFixture(): KnowledgeRoomRelationDto {
  return {
    id: 'rel-1',
    sourceRoomId: 'room-test',
    targetRoomId: 'room-other',
    directed: false,
    type: 'mixed',
    origin: 'auto',
    score: 4.2,
    strength: 'strong',
    sharedSourceCount: 1,
    sharedEntityCount: 1,
    directMentionCount: 1,
    pinned: false,
    hidden: false,
    label: null,
    note: null,
    topReasons: [
      { kind: 'shared_source', contribution: 1.95, key: 'file:file-1', label: '需求原文.md', sourceKind: 'file', sourceId: 'file-1' },
      { kind: 'direct_mention', contribution: 1.25, key: 'doc:doc-1:ent-1', label: '评审纪要', sourceKind: 'everroom-doc', sourceId: 'doc-1', evidence: '两个 Room 共享这份评审纪要' },
      { kind: 'shared_source', contribution: 1, key: 'cal:cal-1', label: '发布评审', sourceKind: 'calendar-event', sourceId: 'cal-1' },
      { kind: 'shared_entity', contribution: 0.5, key: 'ent-java', label: 'Java', entityId: 'ent-java' },
    ],
    updatedAt: '2026-08-26T08:00:00.000Z',
  }
}

function renderInspector(resources: ContextRoomResource[], onSelectResource = vi.fn()) {
  const renderer = TestRenderer.create(
    <RoomRelationInspector
      relation={relationFixture()}
      rooms={[createContextRoomFixture('room-test', '本 Room'), createContextRoomFixture('room-other', '相邻 Room')]}
      resources={resources}
      onSelectResource={onSelectResource}
      onClose={() => {}}
      onChanged={() => {}}
    />,
  )
  return { renderer, onSelectResource }
}

/** 证据区块内的行：button = 可跳转，div = 只读标签。 */
function evidenceRows(root: TestRenderer.ReactTestInstance) {
  const section = root.findByProps({ className: 'context-room-relation-evidence' })
  const rows = section.children.filter(
    (child): child is TestRenderer.ReactTestInstance =>
      typeof child === 'object' && child !== null && typeof (child as { findByType?: unknown }).findByType === 'function',
  )
  return {
    buttons: rows.filter((row) => row.type === 'button'),
    divs: rows.filter((row) => row.type === 'div'),
  }
}

describe('关系图谱：证据行跳转来源资料', () => {
  it('云文档/上传文件的证据行可点开对应资源，连接器来源与共享实体保持只读', async () => {
    const { renderer, onSelectResource } = renderInspector([docResource, fileResource])
    const { buttons, divs } = evidenceRows(renderer.root)
    // file-1 与 doc-1 命中资源库 → 整行按钮；calendar-event / shared_entity 无本地对象 → 只读
    expect(buttons.map((row) => row.findByType('b').children[0])).toEqual(['需求原文.md', '评审纪要'])
    expect(divs.map((row) => row.findByType('b').children[0])).toEqual(['发布评审', 'Java'])

    await act(async () => {
      buttons[0].props.onClick()
    })
    expect(onSelectResource).toHaveBeenCalledWith(fileResource)
    await act(async () => {
      buttons[1].props.onClick()
    })
    expect(onSelectResource).toHaveBeenLastCalledWith(docResource)
  })

  it('资源库为空时全部证据行保持只读', () => {
    const { renderer, onSelectResource } = renderInspector([])
    const { buttons, divs } = evidenceRows(renderer.root)
    expect(buttons).toHaveLength(0)
    expect(divs).toHaveLength(4)
    expect(onSelectResource).not.toHaveBeenCalled()
  })
})
