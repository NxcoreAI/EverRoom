import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EmergenceProjectionResultDto, FocusMindmapStatusDto } from '../../../../../../shared/knowledge'
import { useFocusMindmap } from './useFocusMindmap'

interface Query {
  scope: 'room' | 'document'
  documentId: string | null
  requestVersion: number
}

interface Gated {
  query: Query & { force?: boolean }
  resolve: (dto: FocusMindmapStatusDto) => void
}

const dto = (query: Query, over: Partial<FocusMindmapStatusDto>): FocusMindmapStatusDto => ({
  roomId: 'room-1',
  scope: query.scope,
  scopeId: query.scope === 'document' ? (query.documentId ?? '') : 'room-1',
  status: 'ready',
  error: null,
  generatedAt: null,
  promptVersion: null,
  projection: null,
  requestVersion: query.requestVersion,
  ...over,
})

const projection = (mark: string): EmergenceProjectionResultDto => ({
  cards: [],
  nodes: [{ id: mark, nodeType: 'mindmapTopic', label: mark, sourceGraph: 'mindmap', roomRef: null, updatedAt: '2026-09-19T00:00:00.000Z' }],
  edges: [],
  paths: [],
  focusRootRef: 'mindmap:root',
  scoreComponents: null,
  requestVersion: 0,
  degraded: false,
  degradedReason: null,
  generatedAt: '2026-09-19T00:00:00.000Z',
})

type Mindmap = ReturnType<typeof useFocusMindmap>

let latest: Mindmap | null = null

function Probe({ roomId, documentId }: { roomId: string; documentId: string | null }) {
  latest = useFocusMindmap({ roomId, documentId })
  return null
}

let gets: Query[] = []
let ensures: Array<Query & { force?: boolean }> = []
let gate: Gated[] = []

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
}

const settle = async (entry: Gated, over: Partial<FocusMindmapStatusDto>) => {
  entry.resolve(dto(entry.query, over))
  await flush()
}

beforeEach(() => {
  const g = globalThis as unknown as { window?: unknown; nxcore?: unknown }
  g.window = globalThis
  gets = []
  ensures = []
  gate = []
  g.nxcore = {
    knowledge: {
      focusMindmap: (_roomId: string, query: Query) => {
        gets.push(query)
        return new Promise<FocusMindmapStatusDto>((resolve) => { gate.push({ query, resolve }) })
      },
      ensureFocusMindmap: (_roomId: string, input: Query & { force?: boolean }) => {
        ensures.push(input)
        return new Promise<FocusMindmapStatusDto>((resolve) => { gate.push({ query: input, resolve }) })
      },
    },
  }
})

afterEach(async () => {
  vi.useRealTimers()
  const g = globalThis as unknown as { nxcore?: unknown }
  g.nxcore = undefined
})

describe('useFocusMindmap', () => {
  it('旧版本响应被丢弃：scope 切换后迟到的 ready 不得写入', async () => {
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<Probe roomId="room-1" documentId="doc-1" />)
    })
    expect(gets.map((q) => q.requestVersion)).toEqual([1])
    const firstGet = gate[0]!

    await act(async () => {
      renderer.update(<Probe roomId="room-1" documentId={null} />)
    })
    expect(gets.map((q) => q.requestVersion)).toEqual([1, 2])

    // v1 的 ready 迟到：requestVersion 1 ≠ 当前 2，丢弃。
    await act(async () => {
      await settle(firstGet, { status: 'ready', projection: projection('stale') })
    })
    expect(latest?.projection).toBeNull()
    expect(latest?.failed).toBe(false)

    const secondGet = gate[1]!
    await act(async () => {
      await settle(secondGet, { status: 'ready', projection: projection('fresh') })
    })
    expect(latest?.projection?.nodes[0]?.id).toBe('fresh')
  })

  it('切换 scope 期间保留旧投影，新 ready 才替换', async () => {
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<Probe roomId="room-1" documentId="doc-1" />)
    })
    await act(async () => {
      await settle(gate[0]!, { status: 'ready', projection: projection('doc-tree') })
    })
    expect(latest?.projection?.nodes[0]?.id).toBe('doc-tree')

    await act(async () => {
      renderer.update(<Probe roomId="room-1" documentId={null} />)
    })
    expect(latest?.projection?.nodes[0]?.id).toBe('doc-tree')

    await act(async () => {
      await settle(gate[1]!, { status: 'ready', projection: projection('room-tree') })
    })
    expect(latest?.projection?.nodes[0]?.id).toBe('room-tree')
  })

  it('processing 期间每 4s 轮询，ready 即停', async () => {
    vi.useFakeTimers()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<Probe roomId="room-1" documentId={null} />)
    })
    await act(async () => {
      await settle(gate[0]!, { status: 'processing' })
    })
    expect(latest?.generating).toBe(true)
    expect(gets.length).toBe(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    await act(async () => { await settle(gate[1]!, { status: 'processing' }) })
    expect(gets.length).toBe(2)

    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    await act(async () => { await settle(gate[2]!, { status: 'ready', projection: projection('done') }) })
    expect(gets.length).toBe(3)
    expect(latest?.generating).toBe(false)
    expect(latest?.projection?.nodes[0]?.id).toBe('done')

    await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
    expect(gets.length).toBe(3)
  })

  it('retry 走 ensure 且不带 force；regenerate 带 force 重生成', async () => {
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<Probe roomId="room-1" documentId="doc-1" />)
    })
    await act(async () => {
      await settle(gate[0]!, { status: 'failed', error: 'agent_down' })
    })
    expect(latest?.failed).toBe(true)
    expect(latest?.error).toBe('agent_down')

    await act(async () => {
      latest?.retry()
      await flush()
    })
    expect(ensures.length).toBe(1)
    expect(ensures[0]!.force).toBeUndefined()
    expect(ensures[0]!.scope).toBe('document')
    expect(ensures[0]!.documentId).toBe('doc-1')
    expect(ensures[0]!.requestVersion).toBe(2)
    await act(async () => {
      await settle(gate[1]!, { status: 'ready', projection: projection('recovered') })
    })
    expect(latest?.failed).toBe(false)

    await act(async () => {
      latest?.regenerate()
      await flush()
    })
    expect(ensures.length).toBe(2)
    expect(ensures[1]!.force).toBe(true)
    expect(ensures[1]!.requestVersion).toBe(3)
  })
})
