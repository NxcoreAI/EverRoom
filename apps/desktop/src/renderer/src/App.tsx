import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionLink } from '@nxcore/agent-contract'

import { AgentPanel } from '@/components/AgentPanel'
import {
  resolveAgentSessionLinkRoute,
  type AgentNavigationRequest,
  type AgentSessionRouteRequest,
} from '@/components/agent/agentNavigation'
import { AppErrorDialog } from '@/components/AppErrorDialog'
import { AppToast } from '@/components/AppToast'
import { HighRiskImportReview } from '@/components/HighRiskImportReview'
import { PageCanvas } from '@/components/PageCanvas'
import { Sidebar } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import { MemoryOnboardingGate } from '@/components/onboarding/MemoryOnboardingGate'
import { RoomOnboardingGate } from '@/components/onboarding/RoomOnboardingGate'
import type { ThemeId } from '@/components/ThemeSwitcher'
import type { ContextRoomWorkspaceTab } from '@/components/context-room/contextRoomTabs'
import { useContextRoomState } from '@/components/context-room/ContextRoomStateProvider'
import { pageLabels, type PageId } from '@/data/navigation'
import { onDocumentBlockNavigation } from '@/components/context-room/ported/components/detail-editor/documentBlockNavigation'
import { onDocumentOperationNavigation } from '@/components/context-room/operations/documentOperationNavigation'
import { useLocale } from '@/i18n/LocaleContext'
import { workspaceTabSwipeTarget } from '@/workspaceTabSwipe'

const THEME_STORAGE_KEY = 'nxcore-ce:appearance:v1'
const TAB_SWIPE_THRESHOLD = 72
const themeIds = new Set<ThemeId>(['soft', 'mono', 'crimson', 'nxcore'])

function detectMacDesktop(): boolean {
  const isElectron = Boolean(window.nxcore) || navigator.userAgent.includes('Electron')
  const isMac =
    window.nxcore?.platform === 'darwin' ||
    navigator.platform.startsWith('Mac') ||
    navigator.userAgent.includes('Macintosh')

  return isElectron && isMac
}

function readStoredTheme(): ThemeId {
  try {
    const storedTheme = localStorage.getItem(THEME_STORAGE_KEY)
    return storedTheme && themeIds.has(storedTheme as ThemeId) ? (storedTheme as ThemeId) : 'nxcore'
  } catch {
    return 'nxcore'
  }
}

function readInitialPage(): PageId {
  return 'home'
}

export function App() {
  const { t } = useLocale()
  const { state: contextRoomState, backendReady: contextRoomBackendReady } = useContextRoomState()
  const isMacDesktop = detectMacDesktop()
  const pageMode = window.nxcore?.pageMode ?? 'sources'
  const [activePage, setActivePage] = useState<PageId>(readInitialPage)
  const [contextRoomTabs, setContextRoomTabs] = useState<ContextRoomWorkspaceTab[]>([])
  const [closedContextRoomTabs, setClosedContextRoomTabs] = useState<ContextRoomWorkspaceTab[]>([])
  const [activeContextRoomId, setActiveContextRoomId] = useState<string | null>(null)
  const [agentOpen, setAgentOpen] = useState(true)
  const [agentFocusRequest, setAgentFocusRequest] = useState(0)
  const [agentNavigationRequest, setAgentNavigationRequest] = useState<AgentNavigationRequest | null>(null)
  const [agentSessionRouteRequest, setAgentSessionRouteRequest] = useState<AgentSessionRouteRequest | null>(null)
  const [agentDocumentFocus, setAgentDocumentFocus] = useState<{
    roomId: string
    documentId: string
    blockId?: string | null
    requestId: number
  } | null>(null)
  const documentFocusRequestIdRef = useRef(0)
  const agentNavigationTimerRef = useRef<number | null>(null)
  const workspaceMainRef = useRef<HTMLElement>(null)
  const tabSwipeRef = useRef({ distance: 0, lastAt: 0, lockedUntil: 0 })
  const [navCollapsed, setNavCollapsed] = useState(() => window.matchMedia('(max-width: 1200px)').matches)
  const [contextRoomDetailFocused, setContextRoomDetailFocused] = useState(false)
  const [contextRoomNavRevealed, setContextRoomNavRevealed] = useState(false)
  const [contextRoomHomeRequest, setContextRoomHomeRequest] = useState(0)
  const [suppressRoomOnboarding, setSuppressRoomOnboarding] = useState(false)
  const manualMemoryOnboardingRef = useRef(false)
  const [theme] = useState<ThemeId>(readStoredTheme)

  const isContextRoomFocused = activePage === 'rooms' && contextRoomDetailFocused
  const activeWorkspaceRoomId = activePage === 'rooms' ? activeContextRoomId : null
  const effectiveNavCollapsed = isContextRoomFocused ? !contextRoomNavRevealed : navCollapsed
  const availableContextRooms = useMemo(() => (
    contextRoomState.rooms.map(({ id, title, kind }) => ({ id, title, kind }))
  ), [contextRoomState.rooms])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Theme persistence is optional when storage is unavailable.
    }
  }, [theme])

  useEffect(() => () => {
    if (agentNavigationTimerRef.current !== null) window.clearTimeout(agentNavigationTimerRef.current)
  }, [])

  useEffect(() => {
    const compactWindow = window.matchMedia('(max-width: 1200px)')
    const collapseNavigation = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setNavCollapsed(true)
    }
    collapseNavigation(compactWindow)
    compactWindow.addEventListener('change', collapseNavigation)
    return () => compactWindow.removeEventListener('change', collapseNavigation)
  }, [])

  // 跨页导航事件（非页面树组件用，如连接器引导跳记忆页；照 MEMORY_TAB_EVENT 约定）
  useEffect(() => {
    const open = (event: Event) => {
      const page = (event as CustomEvent<{ page: PageId }>).detail?.page
      if (page) navigate(page)
    }
    window.addEventListener('nxcore:app:navigate', open as EventListener)
    return () => window.removeEventListener('nxcore:app:navigate', open as EventListener)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const navigate = (page: PageId) => {
    if (page === 'sources' && pageMode === 'connectors') page = 'connectors'
    if (page === 'connectors' && pageMode === 'sources') page = 'sources'
    if (agentNavigationTimerRef.current !== null) {
      window.clearTimeout(agentNavigationTimerRef.current)
      agentNavigationTimerRef.current = null
    }
    if (page === 'rooms' && activePage === 'rooms' && contextRoomDetailFocused) {
      setContextRoomHomeRequest((request) => request + 1)
    }
    if (page === 'rooms') setActiveContextRoomId(null)
    setActivePage(page)
  }

  const openContextRoomTab = useCallback((room: ContextRoomWorkspaceTab) => {
    if (manualMemoryOnboardingRef.current) return
    setContextRoomTabs((current) => (
      current.some((tab) => tab.id === room.id)
        ? current.map((tab) => tab.id === room.id ? room : tab)
        : [...current, room]
    ))
    setClosedContextRoomTabs((current) => current.filter((tab) => tab.id !== room.id))
    setActivePage('rooms')
    setActiveContextRoomId(room.id)
  }, [])

  useEffect(() => {
    if (activePage !== 'settings') {
      manualMemoryOnboardingRef.current = false
      setSuppressRoomOnboarding(false)
    }
  }, [activePage])

  const openDocumentTarget = useCallback((target: {
    roomId: string
    documentId: string
    blockId?: string | null
  }) => {
    if (manualMemoryOnboardingRef.current) return
    const room = availableContextRooms.find((item) => item.id === target.roomId)
    if (room) openContextRoomTab(room)
    else {
      setActivePage('rooms')
      setActiveContextRoomId(target.roomId)
    }
    setAgentDocumentFocus({
      roomId: target.roomId,
      documentId: target.documentId,
      blockId: target.blockId ?? null,
      requestId: ++documentFocusRequestIdRef.current,
    })
  }, [availableContextRooms, openContextRoomTab])

  useEffect(() => onDocumentBlockNavigation(openDocumentTarget), [openDocumentTarget])
  useEffect(() => onDocumentOperationNavigation(openDocumentTarget), [openDocumentTarget])

  const activateContextRoomTab = useCallback((roomId: string) => {
    setActivePage('rooms')
    setActiveContextRoomId(roomId)
  }, [])

  const closeContextRoomTab = useCallback((roomId: string) => {
    const closingIndex = contextRoomTabs.findIndex((tab) => tab.id === roomId)
    if (closingIndex < 0) return
    const closingTab = contextRoomTabs[closingIndex]
    const nextTabs = contextRoomTabs.filter((tab) => tab.id !== roomId)
    setContextRoomTabs(nextTabs)
    setClosedContextRoomTabs((current) => [
      closingTab,
      ...current.filter((tab) => tab.id !== roomId),
    ])
    if (activeContextRoomId === roomId) {
      setActiveContextRoomId(nextTabs[closingIndex]?.id ?? nextTabs[closingIndex - 1]?.id ?? null)
    }
  }, [activeContextRoomId, contextRoomTabs])

  const restoreContextRoomTab = useCallback(() => {
    const room = closedContextRoomTabs[0]
    if (!room) return
    openContextRoomTab(room)
  }, [closedContextRoomTabs, openContextRoomTab])

  const syncContextRoomTabs = useCallback((rooms: ContextRoomWorkspaceTab[]) => {
    const roomById = new Map(rooms.map((room) => [room.id, room]))
    setContextRoomTabs((current) => current.flatMap((tab) => {
      const room = roomById.get(tab.id)
      return room ? [room] : []
    }))
    setClosedContextRoomTabs((current) => current.flatMap((tab) => {
      const room = roomById.get(tab.id)
      return room ? [room] : []
    }))
    setActiveContextRoomId((current) => current && roomById.has(current) ? current : null)
  }, [])

  const showContextRoomHome = useCallback(() => {
    setActiveContextRoomId(null)
  }, [])

  const handleContextRoomDetailFocusChange = useCallback((focused: boolean) => {
    setContextRoomDetailFocused(focused)
    if (!focused) setContextRoomNavRevealed(false)
  }, [])

  useEffect(() => {
    const workspace = workspaceMainRef.current
    if (!workspace) return
    let resetTimer: number | null = null

    const roomIds = contextRoomTabs.map((tab) => tab.id)
    const canNestedElementScroll = (target: EventTarget | null, direction: -1 | 1) => {
      if (!(target instanceof Element)) return false
      if (target.closest('input, textarea, select, [contenteditable="true"], canvas, [role="slider"]')) return true

      let element: Element | null = target
      while (element && element !== workspace) {
        const style = window.getComputedStyle(element)
        if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && element.scrollWidth > element.clientWidth + 1) {
          const maxScrollLeft = element.scrollWidth - element.clientWidth
          if ((direction > 0 && element.scrollLeft < maxScrollLeft) || (direction < 0 && element.scrollLeft > 0)) {
            return true
          }
        }
        element = element.parentElement
      }
      return false
    }

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) < 6 || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
      const direction = event.deltaX > 0 ? 1 : -1
      if (canNestedElementScroll(event.target, direction)) return

      event.preventDefault()
      const now = performance.now()
      const swipe = tabSwipeRef.current
      if (now - swipe.lastAt > 180) swipe.distance = 0
      swipe.lastAt = now
      if (now < swipe.lockedUntil) return
      swipe.distance += event.deltaX

      if (resetTimer !== null) window.clearTimeout(resetTimer)
      resetTimer = window.setTimeout(() => { swipe.distance = 0 }, 180)
      if (Math.abs(swipe.distance) < TAB_SWIPE_THRESHOLD) return

      const target = workspaceTabSwipeTarget(roomIds, activeWorkspaceRoomId, direction)
      swipe.distance = 0
      swipe.lockedUntil = now + 520
      if (target === undefined) return
      if (target === null) showContextRoomHome()
      else activateContextRoomTab(target)
    }

    workspace.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      if (resetTimer !== null) window.clearTimeout(resetTimer)
      workspace.removeEventListener('wheel', handleWheel)
    }
  }, [activateContextRoomTab, activeWorkspaceRoomId, contextRoomTabs, showContextRoomHome])

  const focusAgent = () => {
    setAgentOpen(true)
    setAgentFocusRequest((request) => request + 1)
  }

  const navigateFromAgent = (request: AgentNavigationRequest) => {
    setAgentNavigationRequest(request)
    setAgentSessionRouteRequest(null)
    setAgentOpen(true)
    if (agentNavigationTimerRef.current !== null) window.clearTimeout(agentNavigationTimerRef.current)
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180
    agentNavigationTimerRef.current = window.setTimeout(() => {
      agentNavigationTimerRef.current = null
      if (manualMemoryOnboardingRef.current) return
      const { target } = request
      if (target.pageId === 'rooms' && target.roomId) {
        const room = availableContextRooms.find((item) => item.id === target.roomId)
        if (room) openContextRoomTab(room)
        else if (target.objectType === 'room') {
          openContextRoomTab({ id: target.roomId, title: target.title })
        }
        else {
          setActivePage('rooms')
          setActiveContextRoomId(target.roomId)
        }
        setAgentDocumentFocus(target.objectType === 'document' && target.objectId
          ? {
              roomId: target.roomId,
              documentId: target.objectId,
              blockId: target.blockId ?? null,
              requestId: ++documentFocusRequestIdRef.current,
            }
          : null)
        return
      }
      setAgentDocumentFocus(null)
      navigate(target.pageId)
    }, delay)
  }

  const openAgentSessionLink = (link: AgentSessionLink, destination: 'source' | 'target') => {
    if (manualMemoryOnboardingRef.current) return
    const route = resolveAgentSessionLinkRoute(link, destination)
    if (!route) return
    if (agentNavigationTimerRef.current !== null) {
      window.clearTimeout(agentNavigationTimerRef.current)
      agentNavigationTimerRef.current = null
    }
    setAgentNavigationRequest(null)
    setAgentSessionRouteRequest(route)
    setAgentDocumentFocus(route.pageId === 'rooms' && route.roomId && route.documentId
      ? {
          roomId: route.roomId,
          documentId: route.documentId,
          blockId: route.blockId ?? null,
          requestId: ++documentFocusRequestIdRef.current,
        }
      : null)
    if (route.pageId === 'rooms' && route.roomId) {
      const room = availableContextRooms.find((item) => item.id === route.roomId)
      if (room) openContextRoomTab(room)
      else {
        setActivePage('rooms')
        setActiveContextRoomId(route.roomId)
      }
      return
    }
    navigate(route.pageId)
  }

  return (
    <MemoryOnboardingGate>
      {({ openMemoryOnboarding }) => (
      <RoomOnboardingGate onOpenRoom={openContextRoomTab} suppressOnboarding={suppressRoomOnboarding}>
      {({ openRoomOnboarding }) => (
      <div
      className="app-shell"
      data-agent-open={String(agentOpen)}
      data-context-room-focused={String(isContextRoomFocused)}
      data-mac-desktop={String(isMacDesktop)}
      data-nav-collapsed={String(effectiveNavCollapsed)}
    >
      <TopBar
        contextRoomTabs={contextRoomTabs}
        activeContextRoomId={activeWorkspaceRoomId}
        agentOpen={agentOpen}
        navCollapsed={effectiveNavCollapsed}
        onActivateWorkbench={() => {
          if (activePage === 'rooms' && activeContextRoomId) showContextRoomHome()
        }}
        onActivateContextRoom={activateContextRoomTab}
        onCloseContextRoom={closeContextRoomTab}
        onRestoreContextRoom={restoreContextRoomTab}
        canRestoreContextRoom={closedContextRoomTabs.length > 0}
        onToggleAgent={() => setAgentOpen((open) => {
          const next = !open
          if (next && window.matchMedia('(max-width: 900px)').matches) setNavCollapsed(true)
          return next
        })}
        onToggleNav={() => {
          if (isContextRoomFocused) {
            setContextRoomNavRevealed((revealed) => !revealed)
            return
          }
          setNavCollapsed((collapsed) => {
            const next = !collapsed
            if (!next && window.matchMedia('(max-width: 900px)').matches) setAgentOpen(false)
            return next
          })
        }}
      />
      <Sidebar activePage={activePage} onNavigate={navigate} />
      <main ref={workspaceMainRef} className="workspace-main">
        <PageCanvas
          page={activePage}
          activeContextRoomId={activeContextRoomId}
          agentDocumentFocus={agentDocumentFocus}
          contextRoomHomeRequest={contextRoomHomeRequest}
          onContextRoomDetailFocusChange={handleContextRoomDetailFocusChange}
          onContextRoomOpenTab={openContextRoomTab}
          onContextRoomRoomsChange={syncContextRoomTabs}
          onContextRoomShowHome={showContextRoomHome}
          onNavigate={navigate}
          onFocusAgent={focusAgent}
          onOpenDocument={openDocumentTarget}
          onStartRoomOnboarding={() => {
            manualMemoryOnboardingRef.current = false
            setSuppressRoomOnboarding(false)
            setActiveContextRoomId(null)
            setActivePage('settings')
            openRoomOnboarding()
          }}
          onStartMemoryOnboarding={() => {
            if (agentNavigationTimerRef.current !== null) {
              window.clearTimeout(agentNavigationTimerRef.current)
              agentNavigationTimerRef.current = null
            }
            manualMemoryOnboardingRef.current = true
            setSuppressRoomOnboarding(true)
            setActiveContextRoomId(null)
            setAgentNavigationRequest(null)
            setAgentSessionRouteRequest(null)
            setAgentDocumentFocus(null)
            setActivePage('settings')
            openMemoryOnboarding()
          }}
        />
      </main>
      {agentOpen ? (
        <AgentPanel
          pageId={activePage}
          pageLabel={t(pageLabels[activePage])}
          roomId={activePage === 'rooms' ? activeContextRoomId : null}
          rooms={availableContextRooms}
          roomBackendReady={contextRoomBackendReady}
          navigationRequest={agentNavigationRequest}
          sessionRouteRequest={agentSessionRouteRequest}
          onNavigate={navigateFromAgent}
          onNavigationConsumed={(key) => setAgentNavigationRequest((current) => current?.key === key ? null : current)}
          onOpenSessionLink={openAgentSessionLink}
          onOpenDocument={openDocumentTarget}
          onSessionRouteConsumed={(key) => setAgentSessionRouteRequest((current) => current?.key === key ? null : current)}
          focusRequest={agentFocusRequest}
        />
      ) : null}
      <HighRiskImportReview />
      <AppToast />
      <AppErrorDialog />
      </div>
      )}
      </RoomOnboardingGate>
      )}
    </MemoryOnboardingGate>
  )
}
