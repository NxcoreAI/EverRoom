import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  KnowledgeRoomGraphDto,
  KnowledgeRoomRelationVisibility,
} from '../../../../../../shared/knowledge'

/** 纯数据深比较：DTO 均为 JSON 形状（字符串/数字/布尔/数组/普通对象）。 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) =>
    deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

/**
 * 语义等价：indexing + nodes + edges 一致即视为同一张图。
 * revision/generatedAt 是投影新鲜度元数据，其变化不改变布局数据；
 * 两个图组件的 UI 均只消费这三个字段。everroom:knowledge-changed 事件
 * 高频触发的重拉靠这层短路避免下游 memo 链失效导致的整图重建。
 */
function roomGraphSemanticEqual(left: KnowledgeRoomGraphDto, right: KnowledgeRoomGraphDto): boolean {
  return deepEqual(left.indexing, right.indexing)
    && deepEqual(left.nodes, right.nodes)
    && deepEqual(left.edges, right.edges)
}

export function useRoomRelationGraph(
  roomId: string | null,
  visibility: KnowledgeRoomRelationVisibility = 'active',
) {
  const [graph, setGraph] = useState<KnowledgeRoomGraphDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const requestRef = useRef(0)

  const reload = useCallback(async () => {
    const api = typeof window === 'undefined' ? undefined : window.nxcore?.knowledge
    if (!api?.getRoomGraph || !api.getRoomRelations) {
      setError('service_unavailable')
      setLoading(false)
      return
    }
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    try {
      const next = roomId
        ? await api.getRoomRelations(roomId, visibility)
        : await api.getRoomGraph(visibility)
      if (requestRef.current !== requestId) return
      // 等价短路：保持当前引用，下游 nodes/edges memo 与布局/渲染器才不会重建。
      setGraph((current) => (current && roomGraphSemanticEqual(current, next) ? current : next))
      setError(null)
    } catch (cause) {
      if (requestRef.current !== requestId) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (requestRef.current === requestId) setLoading(false)
    }
  }, [roomId, visibility])

  useEffect(() => {
    setLoading(true)
    void reload()
    if (typeof window === 'undefined') return () => { requestRef.current += 1 }
    const onChanged = () => void reload()
    window.addEventListener('everroom:knowledge-changed', onChanged)
    return () => {
      requestRef.current += 1
      window.removeEventListener('everroom:knowledge-changed', onChanged)
    }
  }, [reload])

  return { error, graph, loading, reload }
}
