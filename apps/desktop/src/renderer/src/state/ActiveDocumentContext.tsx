import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { AgentActiveDocumentContext, AgentDocumentCursorAnchor } from '@nxcore/agent-contract'

import {
  buildActiveDocumentRunContext,
  normalizeCursorAnchorCandidate,
  type ActiveDocumentAnchorMode,
  type ActiveDocumentDescriptor,
} from '@/components/agent/activeDocumentContext'

export interface ActiveDocumentFlushResult {
  title?: string
  version?: number
}

export interface ActiveDocumentRegistration extends ActiveDocumentDescriptor {
  flush?: () => Promise<ActiveDocumentFlushResult | void>
  getCursorAnchorCandidate?: () => AgentDocumentCursorAnchor | null | undefined
}

export interface ActiveDocumentRegistrationUpdate extends Partial<ActiveDocumentRegistration> {}

export interface ActiveDocumentRegistrationHandle {
  update(update: ActiveDocumentRegistrationUpdate): void
  deactivate(): void
}

export interface PrepareActiveDocumentRunOptions {
  anchorMode?: ActiveDocumentAnchorMode
}

interface StoredRegistration extends ActiveDocumentRegistration {
  token: number
}

export interface ActiveDocumentContextValue {
  activeDocument: ActiveDocumentDescriptor | null
  activateDocument(registration: ActiveDocumentRegistration): ActiveDocumentRegistrationHandle
  clearActiveDocument(): void
  flushActiveDocument(): Promise<ActiveDocumentDescriptor | null>
  prepareActiveDocumentRun(
    prompt: string,
    options?: PrepareActiveDocumentRunOptions,
  ): Promise<AgentActiveDocumentContext | null>
}

const ActiveDocumentContext = createContext<ActiveDocumentContextValue | null>(null)

function publicDescriptor(registration: StoredRegistration | null): ActiveDocumentDescriptor | null {
  if (!registration) return null
  return {
    roomId: registration.roomId,
    documentId: registration.documentId,
    title: registration.title,
    version: registration.version,
    ...(registration.cursorAnchorCandidate
      ? { cursorAnchorCandidate: registration.cursorAnchorCandidate }
      : {}),
  }
}

export function ActiveDocumentProvider({ children }: { children: ReactNode }) {
  const registrationRef = useRef<StoredRegistration | null>(null)
  const nextTokenRef = useRef(0)
  const [activeDocument, setActiveDocument] = useState<ActiveDocumentDescriptor | null>(null)

  const publish = useCallback(() => {
    setActiveDocument(publicDescriptor(registrationRef.current))
  }, [])

  const activateDocument = useCallback((registration: ActiveDocumentRegistration) => {
    const token = ++nextTokenRef.current
    registrationRef.current = {
      ...registration,
      token,
      cursorAnchorCandidate: normalizeCursorAnchorCandidate(registration.cursorAnchorCandidate),
    }
    publish()

    return {
      update(update: ActiveDocumentRegistrationUpdate) {
        const current = registrationRef.current
        if (!current || current.token !== token) return
        registrationRef.current = {
          ...current,
          ...update,
          token,
          cursorAnchorCandidate: update.cursorAnchorCandidate === undefined
            ? current.cursorAnchorCandidate
            : normalizeCursorAnchorCandidate(update.cursorAnchorCandidate),
        }
        publish()
      },
      deactivate() {
        if (registrationRef.current?.token !== token) return
        registrationRef.current = null
        publish()
      },
    } satisfies ActiveDocumentRegistrationHandle
  }, [publish])

  const clearActiveDocument = useCallback(() => {
    registrationRef.current = null
    publish()
  }, [publish])

  const flushActiveDocument = useCallback(async () => {
    const registration = registrationRef.current
    if (!registration) return null
    const result = await registration.flush?.()
    const current = registrationRef.current
    if (!current || current.token !== registration.token) return publicDescriptor(current)

    const cursorAnchorCandidate = normalizeCursorAnchorCandidate(
      current.getCursorAnchorCandidate?.() ?? current.cursorAnchorCandidate,
    )
    registrationRef.current = {
      ...current,
      ...(result?.title !== undefined ? { title: result.title } : {}),
      ...(result?.version !== undefined ? { version: result.version } : {}),
      cursorAnchorCandidate,
    }
    publish()
    return publicDescriptor(registrationRef.current)
  }, [publish])

  const prepareActiveDocumentRun = useCallback(async (
    prompt: string,
    options: PrepareActiveDocumentRunOptions = {},
  ) => {
    const descriptor = await flushActiveDocument()
    return buildActiveDocumentRunContext(descriptor, prompt, options)
  }, [flushActiveDocument])

  const value = useMemo<ActiveDocumentContextValue>(() => ({
    activeDocument,
    activateDocument,
    clearActiveDocument,
    flushActiveDocument,
    prepareActiveDocumentRun,
  }), [activeDocument, activateDocument, clearActiveDocument, flushActiveDocument, prepareActiveDocumentRun])

  return <ActiveDocumentContext.Provider value={value}>{children}</ActiveDocumentContext.Provider>
}

export function useActiveDocument(): ActiveDocumentContextValue {
  const value = useContext(ActiveDocumentContext)
  if (!value) throw new Error('useActiveDocument must be used inside ActiveDocumentProvider')
  return value
}

export function useOptionalActiveDocument(): ActiveDocumentContextValue | null {
  return useContext(ActiveDocumentContext)
}
