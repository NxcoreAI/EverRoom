import { useEffect, useRef, useState } from 'react'
import type { RoomAppliedEntitiesResult } from '@nxcore/agent-contract'

/**
 * Room 应用记忆（结构化实体 + 事实表实时数据）：
 * 挂载即拉取一次；everroom:knowledge-changed 与 room.updatedAt
 * 变化时刷新；后端暂不可用时静默保留上次数据。
 * 返回 null 表示尚无数据，调用方回退到 Room 静态派生内容。
 */
export type RoomAppliedMemory = Pick<RoomAppliedEntitiesResult, 'entities' | 'facts'>

export function useRoomAppliedEntities(
  roomId: string,
  roomUpdatedAt?: string,
): RoomAppliedMemory | null {
  const [memory, setMemory] = useState<RoomAppliedMemory | null>(null)
  const refreshRef = useRef<() => void>(() => undefined)
  const lastUpdatedAtRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    setMemory(null)
    let cancelled = false
    let inFlight = false
    let pending = false
    const refresh = async () => {
      if (inFlight) {
        pending = true
        return
      }
      inFlight = true
      try {
        const result = await window.nxcore?.contextRooms?.roomEntities?.(roomId)
        if (!cancelled && result) setMemory({ entities: result.entities, facts: result.facts })
      } catch {
        // 保留上次数据，等事件或 updatedAt 变化时重试
      } finally {
        inFlight = false
        if (pending && !cancelled) {
          pending = false
          void refresh()
        }
      }
    }
    refreshRef.current = () => { void refresh() }
    void refresh()
    const onKnowledgeChanged = () => void refresh()
    window.addEventListener('everroom:knowledge-changed', onKnowledgeChanged)
    return () => {
      cancelled = true
      window.removeEventListener('everroom:knowledge-changed', onKnowledgeChanged)
    }
  }, [roomId])

  useEffect(() => {
    if (roomUpdatedAt === undefined || roomUpdatedAt === lastUpdatedAtRef.current) return
    lastUpdatedAtRef.current = roomUpdatedAt
    refreshRef.current()
  }, [roomUpdatedAt])

  return memory
}
