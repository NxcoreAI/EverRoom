import { useCallback, useEffect, useState } from 'react'

import { AgentPanel } from '@/components/AgentPanel'
import { AppErrorDialog } from '@/components/AppErrorDialog'
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

export function App() {
  const isMacDesktop = detectMacDesktop()
  const [activePage, setActivePage] = useState<PageId>('home')
  const [tabs, setTabs] = useState<PageId[]>(['home'])
  const [contextRoomTabs, setContextRoomTabs] = useState<ContextRoomWorkspaceTab[]>([])
  const [closedContextRoomTabs, setClosedContextRoomTabs] = useState<ContextRoomWorkspaceTab[]>([])
  const [activeContextRoomId, setActiveContextRoomId] = useState<string | null>(null)
  const [agentOpen, setAgentOpen] = useState(true)
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

  const navigate = (page: PageId) => {
    if (page === 'rooms' && activePage === 'rooms' && contextRoomDetailFocused) {
      setContextRoomHomeRequest((request) => request + 1)
    }
    if (page === 'rooms') setActiveContextRoomId(null)
    setActivePage(page)
    setTabs((current) => (current.includes(page) ? current : [...current, page]))
  }

  const openContextRoomTab = useCallback((room: ContextRoomWorkspaceTab) => {
    setContextRoomTabs((current) => (
      current.some((tab) => tab.id === room.id)
        ? current.map((tab) => tab.id === room.id ? room : tab)
        : [...current, room]
    ))
    setClosedContextRoomTabs((current) => current.filter((tab) => tab.id !== room.id))
    setTabs((current) => current.includes('rooms') ? current : [...current, 'rooms'])
    setActivePage('rooms')
    setActiveContextRoomId(room.id)
  }, [])

  const activateContextRoomTab = useCallback((roomId: string) => {
    setTabs((current) => current.includes('rooms') ? current : [...current, 'rooms'])
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

  const closeTab = (page: PageId) => {
    setTabs((current) => {
      const next = current.filter((item) => item !== page)
      if (activePage === page) setActivePage(next.at(-1) ?? 'home')
      return next
    })
  }

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
        activePage={activePage}
        tabs={tabs}
        contextRoomTabs={contextRoomTabs}
        activeContextRoomId={activePage === 'rooms' ? activeContextRoomId : null}
        agentOpen={agentOpen}
        navCollapsed={effectiveNavCollapsed}
        theme={theme}
        onActivate={navigate}
        onClose={closeTab}
        onActivateContextRoom={activateContextRoomTab}
        onCloseContextRoom={closeContextRoomTab}
        onRestoreContextRoom={restoreContextRoomTab}
        canRestoreContextRoom={closedContextRoomTabs.length > 0}
        onToggleAgent={() => setAgentOpen((open) => !open)}
        onToggleNav={() => {
          if (isContextRoomFocused) {
            setContextRoomNavRevealed((revealed) => !revealed)
            return
          }
          setNavCollapsed((collapsed) => !collapsed)
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
        />
      </main>
      {agentOpen ? <AgentPanel pageLabel={pageLabels[activePage]} focusRequest={agentFocusRequest} /> : null}
      <AppErrorDialog />
    </div>
  )
}
