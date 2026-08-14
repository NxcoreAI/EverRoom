import { useEffect, useState } from 'react'

import { AgentPanel } from '@/components/AgentPanel'
import { PageCanvas } from '@/components/PageCanvas'
import { Sidebar } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import type { ThemeId } from '@/components/ThemeSwitcher'
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
  const [agentOpen, setAgentOpen] = useState(true)
  const [navCollapsed, setNavCollapsed] = useState(() => window.matchMedia('(max-width: 1200px)').matches)
  const [theme, setTheme] = useState<ThemeId>(readStoredTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Theme persistence is optional when storage is unavailable.
    }
  }, [theme])

  const navigate = (page: PageId) => {
    setActivePage(page)
    setTabs((current) => (current.includes(page) ? current : [...current, page]))
  }

  const closeTab = (page: PageId) => {
    setTabs((current) => {
      const next = current.filter((item) => item !== page)
      if (activePage === page) setActivePage(next.at(-1) ?? 'home')
      return next
    })
  }

  return (
    <div
      className="app-shell"
      data-agent-open={String(agentOpen)}
      data-mac-desktop={String(isMacDesktop)}
      data-nav-collapsed={String(navCollapsed)}
    >
      <TopBar
        activePage={activePage}
        tabs={tabs}
        agentOpen={agentOpen}
        navCollapsed={navCollapsed}
        theme={theme}
        onActivate={navigate}
        onClose={closeTab}
        onToggleAgent={() => setAgentOpen((open) => !open)}
        onToggleNav={() => setNavCollapsed((collapsed) => !collapsed)}
        onThemeChange={setTheme}
      />
      <Sidebar activePage={activePage} onNavigate={navigate} />
      <main className="workspace-main">
        <PageCanvas page={activePage} onNavigate={navigate} />
      </main>
      {agentOpen ? <AgentPanel pageLabel={pageLabels[activePage]} /> : null}
    </div>
  )
}
