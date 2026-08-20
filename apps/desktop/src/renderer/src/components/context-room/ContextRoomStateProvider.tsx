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

import i18n from '@/i18n/i18next'
import { showToast } from '@/state/toast'
import { removeDemoContextRoomLocalArtifacts } from './ported/demoContextRooms'
import {
  createContextRoomSnapshotInput,
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
  refreshFromBackend: () => Promise<ContextRoomLocalState | null>
}

const ContextRoomStateContext = createContext<ContextRoomStateValue | null>(null)

function fingerprint(input: SaveContextRoomSnapshotInput): string {
  return JSON.stringify(input)
}

export function ContextRoomStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(() => {
    removeDemoContextRoomLocalArtifacts()
    return loadContextRoomLocalState([])
  })
  const [backendReady, setBackendReady] = useState(true)
  const stateRef = useRef(state)
  const mountedRef = useRef(true)
  const syncingRef = useRef(false)
  const pendingRef = useRef<PendingSnapshot | null>(null)
  const lastSyncedFingerprintRef = useRef<string | null>(
    fingerprint(createContextRoomSnapshotInput(state)),
  )
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
    setState(next)
  }, [])

  const showSyncError = () => {
    if (syncErrorShownRef.current) return
    syncErrorShownRef.current = true
    showToast({
      title: i18n.t('contextRoom:contextRoomState.roomNotSynced'),
      message: i18n.t('contextRoom:contextRoomState.localContentPreserved'),
    })
  }

  const refreshFromBackend = useCallback(async (): Promise<ContextRoomLocalState | null> => {
    if (!api) return null
    const snapshot = await api.list()
    const restored = restoreContextRoomSnapshot(snapshot)
    if (!restored) throw new Error(i18n.t('contextRoom:contextRoomState.invalidSnapshot'))
    const restoredInput = createContextRoomSnapshotInput(restored)
    pendingRef.current = null
    lastSyncedFingerprintRef.current = fingerprint(restoredInput)
    retryAttemptRef.current = 0
    syncErrorShownRef.current = false
    stateRef.current = restored
    setState(restored)
    saveContextRoomLocalState(restored)
    setBackendReady(true)
    return restored
  }, [api])

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
            throw new Error(i18n.t('contextRoom:contextRoomState.invalidSnapshot'))
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
    if (!api) return
    const input = createContextRoomSnapshotInput(state)
    const nextFingerprint = fingerprint(input)
    if (nextFingerprint === lastSyncedFingerprintRef.current) return
    pendingRef.current = { input, fingerprint: nextFingerprint }
    setBackendReady(false)
    flushRef.current()
  }, [api, state])

  const value = useMemo(
    () => ({ state, setState: updateState, backendReady, refreshFromBackend }),
    [backendReady, refreshFromBackend, state, updateState],
  )
  return <ContextRoomStateContext.Provider value={value}>{children}</ContextRoomStateContext.Provider>
}

export function useContextRoomState(): ContextRoomStateValue {
  const value = useContext(ContextRoomStateContext)
  if (!value) throw new Error('useContextRoomState must be used inside ContextRoomStateProvider')
  return value
}
