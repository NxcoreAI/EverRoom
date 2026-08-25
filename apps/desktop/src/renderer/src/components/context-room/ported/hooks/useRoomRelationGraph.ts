import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  KnowledgeRoomGraphDto,
  KnowledgeRoomRelationVisibility,
} from '../../../../../../shared/knowledge'

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
      setGraph(next)
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
