import { useEffect, useRef, useState } from 'react'
import type { RoomAppliedEntity } from '@nxcore/agent-contract'

const POLL_INTERVAL_MS = 5_000

/**
 * Room 应用实体（结构化实体表实时数据）：
 * 面板可见期间每 5s 轮询；everroom:knowledge-changed 与 room.updatedAt
 * 变化时立即刷新；后端暂不可用时静默保留上次数据，等待下一轮。
 * 返回 null 表示尚无数据，调用方回退到 Room 静态派生实体。
 */
export function useRoomAppliedEntities(
  roomId: string,
  roomUpdatedAt?: string,
): RoomAppliedEntity[] | null {
  const [entities, setEntities] = useState<RoomAppliedEntity[] | null>(null)
  const refreshRef = useRef<() => void>(() => undefined)
  const lastUpdatedAtRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    setEntities(null)
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
        if (!cancelled && result) setEntities(result.entities)
      } catch {
        // 保留上次数据，下一轮轮询重试
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
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
    const onKnowledgeChanged = () => void refresh()
    window.addEventListener('everroom:knowledge-changed', onKnowledgeChanged)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('everroom:knowledge-changed', onKnowledgeChanged)
    }
  }, [roomId])

  useEffect(() => {
    if (roomUpdatedAt === undefined || roomUpdatedAt === lastUpdatedAtRef.current) return
    lastUpdatedAtRef.current = roomUpdatedAt
    refreshRef.current()
  }, [roomUpdatedAt])

  return entities
}
