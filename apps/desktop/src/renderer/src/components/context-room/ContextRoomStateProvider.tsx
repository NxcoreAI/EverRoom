import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import type { SaveContextRoomSnapshotInput } from '@nxcore/agent-contract'

import { showToast } from '@/state/toast'
import { CONTEXT_ROOMS } from './ported/data'
import {
  createContextRoomSnapshotInput,
  isContextRoomSnapshotEmpty,
  loadContextRoomLocalState,
  restoreContextRoomSnapshot,
  saveContextRoomLocalState,
  type ContextRoomLocalState,
} from './ported/contextRoomLocalState'

const SYNC_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const

interface PendingSnapshot {
  fingerprint: string
  input: SaveContextRoomSnapshotInput
}

interface ContextRoomStateValue {
  state: ContextRoomLocalState
  setState: Dispatch<SetStateAction<ContextRoomLocalState>>
  backendReady: boolean
}

const ContextRoomStateContext = createContext<ContextRoomStateValue | null>(null)

function fingerprint(input: SaveContextRoomSnapshotInput): string {
  return JSON.stringify(input)
}

export function ContextRoomStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(() => loadContextRoomLocalState(CONTEXT_ROOMS))
  const [backendReady, setBackendReady] = useState(false)
  const stateRef = useRef(state)
  const mountedRef = useRef(true)
  const bootstrappedRef = useRef(false)
  const syncingRef = useRef(false)
  const pendingRef = useRef<PendingSnapshot | null>(null)
  const lastSyncedFingerprintRef = useRef<string | null>(null)
  const retryAttemptRef = useRef(0)
  const retryTimerRef = useRef<number | null>(null)
  const syncErrorShownRef = useRef(false)
  const flushRef = useRef<() => void>(() => undefined)
  const api = window.nxcore?.contextRooms

  stateRef.current = state

  const updateState = useCallback<Dispatch<SetStateAction<ContextRoomLocalState>>>((value) => {
    const current = stateRef.current
    const next = typeof value === 'function'
      ? (value as (previous: ContextRoomLocalState) => ContextRoomLocalState)(current)
      : value
    if (Object.is(current, next)) return
    stateRef.current = next
    if (bootstrappedRef.current) setBackendReady(false)
    setState(next)
  }, [])

  const showSyncError = () => {
    if (syncErrorShownRef.current) return
    syncErrorShownRef.current = true
    showToast({
      title: 'Room 暂未同步',
      message: '本地内容已保留，连接恢复后会自动重试。',
    })
  }

  flushRef.current = () => {
    if (
      !api
      || syncingRef.current
      || retryTimerRef.current !== null
      || !pendingRef.current
      || !mountedRef.current
    ) return
    syncingRef.current = true
    void (async () => {
      while (pendingRef.current && mountedRef.current) {
        const pending = pendingRef.current
        pendingRef.current = null
        try {
          const snapshot = await api.syncSnapshot(pending.input)
          if (!mountedRef.current) return
          if (!restoreContextRoomSnapshot(snapshot)) {
            throw new Error('Room 快照格式无效')
          }
          lastSyncedFingerprintRef.current = pending.fingerprint
          retryAttemptRef.current = 0
          syncErrorShownRef.current = false
        } catch {
          if (!mountedRef.current) return
          pendingRef.current ??= pending
          setBackendReady(false)
          showSyncError()
          const retryDelay = SYNC_RETRY_DELAYS_MS[
            Math.min(retryAttemptRef.current, SYNC_RETRY_DELAYS_MS.length - 1)
          ]
          retryAttemptRef.current += 1
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null
            flushRef.current()
          }, retryDelay)
          break
        }
      }
      syncingRef.current = false
      if (!mountedRef.current) return
      if (retryTimerRef.current !== null) return
      const latestInput = createContextRoomSnapshotInput(stateRef.current)
      const latestFingerprint = fingerprint(latestInput)
      if (latestFingerprint !== lastSyncedFingerprintRef.current) {
        pendingRef.current = { input: latestInput, fingerprint: latestFingerprint }
        setBackendReady(false)
        flushRef.current()
      } else if (!pendingRef.current) {
        setBackendReady(true)
      }
    })()
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
    }
  }, [])

  useEffect(() => {
    saveContextRoomLocalState(state)
    if (!api || !bootstrappedRef.current) return
    const input = createContextRoomSnapshotInput(state)
    const nextFingerprint = fingerprint(input)
    if (nextFingerprint === lastSyncedFingerprintRef.current) return
    pendingRef.current = { input, fingerprint: nextFingerprint }
    setBackendReady(false)
    flushRef.current()
  }, [api, state])

  useEffect(() => {
    if (!api) {
      bootstrappedRef.current = true
      setBackendReady(true)
      return undefined
    }
    let cancelled = false
    let retryAttempt = 0
    const bootstrap = async () => {
      while (!cancelled) {
        try {
          const remote = await api.list()
          if (cancelled) return
          const remoteEmpty = isContextRoomSnapshotEmpty(remote)
          const importInput = remoteEmpty ? createContextRoomSnapshotInput(stateRef.current) : null
          const snapshot = importInput ? await api.syncSnapshot(importInput) : remote
          if (cancelled) return
          const restored = restoreContextRoomSnapshot(snapshot)
          if (!restored) throw new Error('Room 快照格式无效')
          const restoredInput = createContextRoomSnapshotInput(restored)
          lastSyncedFingerprintRef.current = fingerprint(restoredInput)
          bootstrappedRef.current = true
          syncErrorShownRef.current = false
          if (importInput) {
            const latestInput = createContextRoomSnapshotInput(stateRef.current)
            const latestFingerprint = fingerprint(latestInput)
            if (latestFingerprint !== fingerprint(importInput)) {
              pendingRef.current = { input: latestInput, fingerprint: latestFingerprint }
              setBackendReady(false)
              flushRef.current()
              return
            }
          }
          stateRef.current = restored
          setState(restored)
          saveContextRoomLocalState(restored)
          setBackendReady(true)
          return
        } catch {
          if (cancelled) return
          showSyncError()
          setBackendReady(false)
          const delay = SYNC_RETRY_DELAYS_MS[Math.min(retryAttempt, SYNC_RETRY_DELAYS_MS.length - 1)]
          retryAttempt += 1
          await new Promise((resolve) => window.setTimeout(resolve, delay))
        }
      }
    }
    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [api])

  const value = useMemo(
    () => ({ state, setState: updateState, backendReady }),
    [backendReady, state, updateState],
  )
  return <ContextRoomStateContext.Provider value={value}>{children}</ContextRoomStateContext.Provider>
}

export function useContextRoomState(): ContextRoomStateValue {
  const value = useContext(ContextRoomStateContext)
  if (!value) throw new Error('useContextRoomState must be used inside ContextRoomStateProvider')
  return value
}
