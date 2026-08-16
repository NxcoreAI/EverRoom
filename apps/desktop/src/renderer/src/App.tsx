import { useCallback, useEffect, useState } from 'react'

import { AgentPanel } from '@/components/AgentPanel'
import { AppErrorDialog } from '@/components/AppErrorDialog'
import { AppToast } from '@/components/AppToast'
import { PageCanvas } from '@/components/PageCanvas'
import { Sidebar } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import type { ThemeId } from '@/components/ThemeSwitcher'
import type { ContextRoomWorkspaceTab } from '@/components/context-room/contextRoomTabs'
import { pageLabels, type PageId } from '@/data/navigation'

const THEME_STORAGE_KEY = 'nxcore-ce:appearance:v1'
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
  try {
    return window.nxcore?.connectorDebug.enabled && new URLSearchParams(window.location.search).get('page') === 'connector-debug'
      ? 'connector-debug'
      : 'home'
  } catch {
    return 'home'
  }
}

export function App() {
  const isMacDesktop = detectMacDesktop()
  const [activePage, setActivePage] = useState<PageId>(readInitialPage)
  const [contextRoomTabs, setContextRoomTabs] = useState<ContextRoomWorkspaceTab[]>([])
  const [closedContextRoomTabs, setClosedContextRoomTabs] = useState<ContextRoomWorkspaceTab[]>([])
  const [activeContextRoomId, setActiveContextRoomId] = useState<string | null>(null)
  const [agentOpen, setAgentOpen] = useState(() => readInitialPage() !== 'connector-debug')
  const [agentFocusRequest, setAgentFocusRequest] = useState(0)
  const [navCollapsed, setNavCollapsed] = useState(() => window.matchMedia('(max-width: 1200px)').matches)
  const [contextRoomDetailFocused, setContextRoomDetailFocused] = useState(false)
  const [contextRoomNavRevealed, setContextRoomNavRevealed] = useState(false)
  const [contextRoomHomeRequest, setContextRoomHomeRequest] = useState(0)
  const [theme, setTheme] = useState<ThemeId>(readStoredTheme)

  const isContextRoomFocused = activePage === 'rooms' && contextRoomDetailFocused
  const effectiveNavCollapsed = isContextRoomFocused ? !contextRoomNavRevealed : navCollapsed

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Theme persistence is optional when storage is unavailable.
    }
  }, [theme])

  useEffect(() => {
    const compactWindow = window.matchMedia('(max-width: 1200px)')
    const collapseNavigation = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setNavCollapsed(true)
    }
    collapseNavigation(compactWindow)
    compactWindow.addEventListener('change', collapseNavigation)
    return () => compactWindow.removeEventListener('change', collapseNavigation)
  }, [])

  const navigate = (page: PageId) => {
    if (page === 'rooms' && activePage === 'rooms' && contextRoomDetailFocused) {
      setContextRoomHomeRequest((request) => request + 1)
    }
    if (page === 'rooms') setActiveContextRoomId(null)
    setActivePage(page)
  }

  const openContextRoomTab = useCallback((room: ContextRoomWorkspaceTab) => {
    setContextRoomTabs((current) => (
      current.some((tab) => tab.id === room.id)
        ? current.map((tab) => tab.id === room.id ? room : tab)
        : [...current, room]
    ))
    setClosedContextRoomTabs((current) => current.filter((tab) => tab.id !== room.id))
    setActivePage('rooms')
    setActiveContextRoomId(room.id)
  }, [])

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

  const focusAgent = () => {
    setAgentOpen(true)
    setAgentFocusRequest((request) => request + 1)
  }

  return (
    <div
      className="app-shell"
      data-agent-open={String(agentOpen)}
      data-context-room-focused={String(isContextRoomFocused)}
      data-mac-desktop={String(isMacDesktop)}
      data-nav-collapsed={String(effectiveNavCollapsed)}
    >
      <TopBar
        contextRoomTabs={contextRoomTabs}
        activeContextRoomId={activePage === 'rooms' ? activeContextRoomId : null}
        agentOpen={agentOpen}
        navCollapsed={effectiveNavCollapsed}
        theme={theme}
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
        onThemeChange={setTheme}
      />
      <Sidebar activePage={activePage} onNavigate={navigate} />
      <main className="workspace-main">
        <PageCanvas
          page={activePage}
          activeContextRoomId={activeContextRoomId}
          contextRoomHomeRequest={contextRoomHomeRequest}
          onContextRoomDetailFocusChange={handleContextRoomDetailFocusChange}
          onContextRoomOpenTab={openContextRoomTab}
          onContextRoomRoomsChange={syncContextRoomTabs}
          onContextRoomShowHome={showContextRoomHome}
          onNavigate={navigate}
          onFocusAgent={focusAgent}
          onOpenConnectorDebug={() => {
            setAgentOpen(false)
            setActivePage('connector-debug')
          }}
        />
      </main>
      {agentOpen ? (
        <AgentPanel
          pageLabel={pageLabels[activePage]}
          roomId={activePage === 'rooms' ? activeContextRoomId : null}
          focusRequest={agentFocusRequest}
        />
      ) : null}
      <AppToast />
      <AppErrorDialog />
    </div>
  )
}
