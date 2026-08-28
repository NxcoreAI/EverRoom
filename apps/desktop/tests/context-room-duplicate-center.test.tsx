import TestRenderer, { act } from 'react-test-renderer'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { RoomDuplicateCandidate, RoomMergePreview } from '@nxcore/agent-contract'

// 无 DOM 环境：ReferenceDialog（Radix Portal）替换为透传容器，只测弹窗内部状态机。
vi.mock('../src/renderer/src/components/context-room/ported/components/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/context-room/ported/components/shared')>()
  return {
    ...actual,
    ReferenceDialog: function MockReferenceDialog({ open, children }: {
      open: boolean
      children: ReactNode
    }) {
      return open ? <div>{children}</div> : null
    },
  }
})

import { RoomDuplicateCenter } from '../src/renderer/src/components/context-room/ported/components/RoomDuplicateCenter'

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

function duplicateCandidate(): RoomDuplicateCandidate {
  return {
    id: 'cand-1',
    roomAId: 'room-a',
    roomBId: 'room-b',
    roomA: { id: 'room-a', title: '校园生活', kind: '主题' },
    roomB: { id: 'room-b', title: '校园生活记录', kind: '主题' },
    nameScore: 0.9,
    centroidScore: 0.5,
    contentOverlap: 0.6,
    entityOverlap: 0.4,
    duplicateScore: 0.75,
    confidence: 'medium',
    reasons: ['标题相似度 0.90'],
    status: 'open',
    updatedAt: '2026-08-27T00:00:00.000Z',
  }
}

function mergePreview(): RoomMergePreview {
  const impact = {
    documents: 1, externalSources: 0, wikiFiles: 0, localMemories: 0, attributedMemories: 0,
    agentRuns: 0, sessionLinks: 0, entities: 0, relations: 0, unassignedRuns: 0, crossRoomSessions: 0,
  }
  return {
    sourceRoom: { id: 'room-b', title: '校园生活记录', data: { id: 'room-b', title: '校园生活记录' } },
    targetRoom: { id: 'room-a', title: '校园生活', data: { id: 'room-a', title: '校园生活' } },
    recommendedTargetRoomId: 'room-a',
    impact,
    conflicts: [],
    excluded: [],
    previewHash: 'hash-1',
    generatedAt: '2026-08-27T00:00:00.000Z',
  }
}

function textNodes(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root.findAll((node) => (
    typeof node.children === 'string' || Array.isArray(node.children)
      ? node.children.flatMap((child) => (typeof child === 'string' ? [child] : [])).join('').includes(text)
      : false
  ))
}

function buttonByText(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button')
    .find((button) => button.children.flatMap((child) => (typeof child === 'string' ? [child] : [])).join('').includes(label))
}

describe('RoomDuplicateCenter', () => {
  it('returns to the candidate list when reopened after closing from the merge preview', async () => {
    const api = {
      listDuplicateCandidates: vi.fn(async () => ({ items: [duplicateCandidate()] })),
      previewMerge: vi.fn(async () => mergePreview()),
      startMerge: vi.fn(),
      getMergeOperation: vi.fn(),
      retryMerge: vi.fn(),
      cancelMerge: vi.fn(),
      updateDuplicateCandidate: vi.fn(),
    }
    ;(globalThis as { window?: unknown }).window = { nxcore: { contextRooms: api } }
    const onCandidateCountChange = vi.fn()
    const props = {
      onOpenChange: () => undefined,
      onMerged: async () => undefined,
      onCandidateCountChange,
    }

    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<RoomDuplicateCenter open {...props} />)
    })
    expect(api.listDuplicateCandidates).toHaveBeenCalledWith('open')
    expect(onCandidateCountChange).toHaveBeenLastCalledWith(1)

    await act(async () => {
      buttonByText(renderer!, '查看合并影响')!.props.onClick()
    })
    expect(api.previewMerge).toHaveBeenCalledWith('room-b', 'room-a')
    expect(textNodes(renderer!, '将迁移到主 Room')).toHaveLength(1)

    // 从合并预览直接关闭弹窗，再次打开应回到候选列表，而不是残留上一次的预览。
    await act(async () => {
      renderer!.update(<RoomDuplicateCenter open={false} {...props} />)
    })
    await act(async () => {
      renderer!.update(<RoomDuplicateCenter open {...props} />)
    })
    expect(textNodes(renderer!, '将迁移到主 Room')).toHaveLength(0)
    expect(textNodes(renderer!, '校园生活记录').length).toBeGreaterThan(0)
    expect(buttonByText(renderer!, '查看合并影响')).toBeTruthy()
  })

  it('clears the reported count when the service returns no merge-worthy candidates', async () => {
    const api = {
      listDuplicateCandidates: vi.fn(async () => ({ items: [duplicateCandidate()] })),
      previewMerge: vi.fn(),
      startMerge: vi.fn(),
      getMergeOperation: vi.fn(),
      retryMerge: vi.fn(),
      cancelMerge: vi.fn(),
      updateDuplicateCandidate: vi.fn(),
    }
    ;(globalThis as { window?: unknown }).window = { nxcore: { contextRooms: api } }
    const onCandidateCountChange = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <RoomDuplicateCenter open onOpenChange={() => undefined} onMerged={async () => undefined} onCandidateCountChange={onCandidateCountChange} />,
      )
    })
    expect(onCandidateCountChange).toHaveBeenLastCalledWith(1)

    api.listDuplicateCandidates.mockResolvedValue({ items: [] })
    await act(async () => {
      renderer!.root.findByProps({ title: '刷新候选' }).props.onClick()
    })
    expect(onCandidateCountChange).toHaveBeenLastCalledWith(0)
    expect(textNodes(renderer!, '当前没有需要处理的重复 Room')).toHaveLength(1)
  })
})
