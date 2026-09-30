import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { KnowledgeFileDto } from '../../../../shared/knowledge'

/**
 * 各 Room 的 Agent 生成产物清单（uploaded_files 按 sourceKind=agent-generated 过滤），
 * 供文稿页把 Office 产物与云文档合并成一份「最近更新」列表。
 * knowledge 服务可选：不可用/失败时静默降级为空清单。
 * 刷新：Room 列表变化首载 + 监听全局 DOM 事件 'everroom:knowledge-changed'
 * （Agent 生成产物落库后各面板 dispatch）；事件后追加一次尾随刷新，
 * 兜住「产物登记早于文件清单落库」的异步窗口。
 */
export function useRoomAgentFiles(roomIds: string[]): {
  filesByRoom: Record<string, KnowledgeFileDto[]>
  loading: boolean
} {
  const [filesByRoom, setFilesByRoom] = useState<Record<string, KnowledgeFileDto[]>>({})
  const [loading, setLoading] = useState(true)
  const roomKey = useMemo(() => [...roomIds].sort().join('\u0000'), [roomIds])
  const roomKeyRef = useRef(roomKey)
  roomKeyRef.current = roomKey

  const refresh = useCallback(async () => {
    const knowledge = window.nxcore?.knowledge
    if (!knowledge) {
      setLoading(false)
      return
    }
    const currentRoomIds = roomKeyRef.current ? roomKeyRef.current.split('\u0000') : []
    if (currentRoomIds.length === 0) {
      setFilesByRoom({})
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const results = await Promise.all(currentRoomIds.map(async (roomId) => {
        try {
          const { items } = await knowledge.listRoomFiles(roomId)
          return [roomId, items.filter((item) => item.sourceKind === 'agent-generated')] as const
        } catch {
          return [roomId, [] as KnowledgeFileDto[]] as const
        }
      }))
      setFilesByRoom(Object.fromEntries(results))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, roomKey])

  useEffect(() => {
    const onKnowledgeChanged = () => {
      void refresh()
      // 尾随刷新：产物写入与清单落库之间有异步窗口，立即刷新可能仍读到旧清单
      window.setTimeout(() => void refresh(), 800)
    }
    window.addEventListener('everroom:knowledge-changed', onKnowledgeChanged)
    return () => window.removeEventListener('everroom:knowledge-changed', onKnowledgeChanged)
  }, [refresh])

  return { filesByRoom, loading }
}
