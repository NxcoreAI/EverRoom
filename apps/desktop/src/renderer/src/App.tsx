import { ArrowRight, BrainCircuit, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionLink } from '@nxcore/agent-contract'
import type { MemoryAtomicItemDto } from '../../shared/memory'
import { OFFICE_TEST_INSTANCE_ID, type OfficePreviewTab } from '../../shared/sources'

import { AgentPanel } from '@/components/AgentPanel'
import {
  resolveAgentSessionLinkRoute,
  type AgentNavigationRequest,
  type AgentSessionRouteRequest,
} from '@/components/agent/agentNavigation'
import { AppErrorDialog } from '@/components/AppErrorDialog'
import { AppToast } from '@/components/AppToast'
import { RemoteAgentNotificationView } from '@/components/RemoteAgentNotificationView'
import { HighRiskImportReview } from '@/components/HighRiskImportReview'
import { PageCanvas } from '@/components/PageCanvas'
import { Sidebar } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import { MemoryOnboardingGate } from '@/components/onboarding/MemoryOnboardingGate'
import { RoomOnboardingGate } from '@/components/onboarding/RoomOnboardingGate'
import { FolderSettingsOnboarding } from '@/components/onboarding/FolderSettingsOnboarding'
import { OnboardingFlowChrome, type OnboardingFlowStage } from '@/components/onboarding/OnboardingFlowChrome'
import { RuntimeConfigGate } from '@/components/onboarding/RuntimeConfigGate'
import {
  hasExistingOnboardingData,
  readFullOnboardingCompleted,
  writeFullOnboardingCompleted,
} from '@/components/onboarding/fullOnboardingState'
import type { ThemeId } from '@/components/ThemeSwitcher'
import type { ContextRoomWorkspaceTab } from '@/components/context-room/contextRoomTabs'
import { useContextRoomState } from '@/components/context-room/ContextRoomStateProvider'
import { pageLabels, type PageId } from '@/data/navigation'
import {
  ROOM_OVERVIEW_CITATION_ADD_EVENT,
  ROOM_OVERVIEW_CITATION_UPDATE_EVENT,
  clearRoomOverviewCitation,
  type RoomOverviewCitation,
} from '@/components/context-room/roomOverviewCitation'
import { onDocumentBlockNavigation } from '@/components/context-room/ported/components/detail-editor/documentBlockNavigation'
import { onDocumentOperationNavigation } from '@/components/context-room/operations/documentOperationNavigation'
import { useLocale } from '@/i18n/LocaleContext'
import { workspaceTabSwipeTarget } from '@/workspaceTabSwipe'
import './App.css'
import type { AgentNotificationTarget } from '../../shared/notifications'

const THEME_STORAGE_KEY = 'nxcore-ce:appearance:v1'
const TAB_SWIPE_THRESHOLD = 72
const themeIds = new Set<ThemeId>(['soft', 'mono', 'crimson', 'nxcore'])

function logOnboarding(event: string, details: Record<string, unknown> = {}) {
  console.info(`[onboarding] ${event}`, details)
}

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
  const [activeContextRoomId, setActiveContextRoomId] = useState<string | null>(null)
  const [officeTabs, setOfficeTabs] = useState<OfficePreviewTab[]>([])
  const [activeOfficeInstanceId, setActiveOfficeInstanceId] = useState<string | null>(null)
  const [agentOpen, setAgentOpen] = useState(true)
  const [agentFocusRequest, setAgentFocusRequest] = useState(0)
  const [agentRoomCitations, setAgentRoomCitations] = useState<RoomOverviewCitation[]>([])
  const [agentNavigationRequest, setAgentNavigationRequest] = useState<AgentNavigationRequest | null>(null)
  const [agentSessionRouteRequest, setAgentSessionRouteRequest] = useState<AgentSessionRouteRequest | null>(null)
  const [remoteNotificationTarget, setRemoteNotificationTarget] = useState<AgentNotificationTarget | null>(null)
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
  const [fullOnboardingStage, setFullOnboardingStage] = useState<OnboardingFlowStage>('idle')
  const [completedOnboardingStages, setCompletedOnboardingStages] = useState<Set<'folder' | 'memory' | 'room'>>(() => new Set())
  const [folderOnboardingOpen, setFolderOnboardingOpen] = useState(false)
  const [suppressAutomaticOnboarding, setSuppressAutomaticOnboarding] = useState(true)
  const [memoryReady, setMemoryReady] = useState(false)
  const [memoryFocusId, setMemoryFocusId] = useState<string | null>(null)
  const [generatedMemoryNotice, setGeneratedMemoryNotice] = useState<MemoryAtomicItemDto | null>(null)
  const manualMemoryOnboardingRef = useRef(false)
  const fullOnboardingCompletedRef = useRef(readFullOnboardingCompleted())
  const fullOnboardingStageRef = useRef<OnboardingFlowStage>('idle')
  const onboardingCheckRequestRef = useRef(0)
  const openRoomOnboardingRef = useRef<(() => void) | null>(null)
  const openMemoryOnboardingRef = useRef<(() => void) | null>(null)
  const [theme] = useState<ThemeId>(readStoredTheme)

  const isContextRoomFocused = activePage === 'rooms' && contextRoomDetailFocused
  const activeWorkspaceRoomId = activePage === 'rooms' ? activeContextRoomId : null
  const activeWorkspaceOfficeId = activePage === 'office-document' ? activeOfficeInstanceId : null
  const effectiveNavCollapsed = isContextRoomFocused ? !contextRoomNavRevealed : navCollapsed
  const availableContextRooms = useMemo(() => (
    contextRoomState.rooms.map(({ id, title, kind }) => ({ id, title, kind }))
  ), [contextRoomState.rooms])

  // 顶栏 Office 预览标签：同一时刻只激活一个实例，离开预览页时全部隐藏（标签保留）。
  const focusedOfficeInstanceId = activePage === 'office-test'
    ? OFFICE_TEST_INSTANCE_ID
    : activePage === 'office-document' ? activeOfficeInstanceId : null

  useEffect(() => {
    const workspace = workspaceMainRef.current
    const office = window.nxcore?.office
    if (!workspace || !office) return

    if (!focusedOfficeInstanceId) {
      void office.setActiveInstance(null).catch((error) => {
        console.error('Failed to hide the Office view.', error)
      })
      return
    }

    const reportBounds = () => {
      const bounds = workspace.getBoundingClientRect()
      office.setWorkspaceBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      })
    }
    const observer = new ResizeObserver(reportBounds)
    observer.observe(workspace)
    window.addEventListener('resize', reportBounds)
    let disposed = false
    void office.setActiveInstance(focusedOfficeInstanceId).then(() => {
      if (!disposed) reportBounds()
    }).catch((error) => {
      console.error('Failed to open the Office view.', error)
    })
    return () => {
      disposed = true
      observer.disconnect()
      window.removeEventListener('resize', reportBounds)
    }
  }, [focusedOfficeInstanceId, agentOpen, effectiveNavCollapsed])

  useEffect(() => {
    logOnboarding('state', {
      stage: fullOnboardingStage,
      stageRef: fullOnboardingStageRef.current,
      folderOpen: folderOnboardingOpen,
      activePage,
      suppressRoomOnboarding,
    })
  }, [activePage, folderOnboardingOpen, fullOnboardingStage, suppressRoomOnboarding])

  const markOnboardingStageCompleted = useCallback((stage: 'folder' | 'memory' | 'room') => {
    setCompletedOnboardingStages((current) => {
      if (current.has(stage)) return current
      return new Set([...current, stage])
    })
  }, [])

  useEffect(() => {
    const addCitation = (event: Event) => {
      const citation = (event as CustomEvent<RoomOverviewCitation>).detail
      if (activePage !== 'rooms' || !citation?.text || citation.roomId !== activeContextRoomId) return
      setAgentRoomCitations((current) => [...current.filter((item) => item.id !== citation.id), citation])
      setAgentOpen(true)
      setAgentFocusRequest((request) => request + 1)
    }
    window.addEventListener(ROOM_OVERVIEW_CITATION_ADD_EVENT, addCitation as EventListener)
    return () => window.removeEventListener(ROOM_OVERVIEW_CITATION_ADD_EVENT, addCitation as EventListener)
  }, [activeContextRoomId, activePage])

  useEffect(() => {
    const updateCitation = (event: Event) => {
      const citation = (event as CustomEvent<RoomOverviewCitation>).detail
      if (!citation?.id) return
      setAgentRoomCitations((current) => current.map((item) => (item.id === citation.id ? citation : item)))
    }
    window.addEventListener(ROOM_OVERVIEW_CITATION_UPDATE_EVENT, updateCitation as EventListener)
    return () => window.removeEventListener(ROOM_OVERVIEW_CITATION_UPDATE_EVENT, updateCitation as EventListener)
  }, [])

  useEffect(() => {
    if (!agentRoomCitations.length || (activePage === 'rooms'
      && agentRoomCitations.every((citation) => citation.roomId === activeContextRoomId))) return
    agentRoomCitations.forEach((citation) => clearRoomOverviewCitation(citation.id))
    setAgentRoomCitations([])
  }, [activeContextRoomId, activePage, agentRoomCitations])

  const completeAutomaticOnboarding = useCallback(() => {
    writeFullOnboardingCompleted()
    fullOnboardingCompletedRef.current = true
    fullOnboardingStageRef.current = 'idle'
    setFullOnboardingStage('idle')
    setFolderOnboardingOpen(false)
    setSuppressAutomaticOnboarding(true)
    setSuppressRoomOnboarding(false)
  }, [])

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
    setActivePage('rooms')
    setActiveContextRoomId(room.id)
  }, [])

  // 重启后回放历史导航只把 Room 标签页恢复显示，不切换页面、不激活 Room。
  const restoreContextRoomTab = useCallback((target: AgentNavigationRequest['target']) => {
    const room = availableContextRooms.find((item) => item.id === target.roomId)
    if (!room) return
    setContextRoomTabs((current) => (
      current.some((tab) => tab.id === room.id)
        ? current.map((tab) => tab.id === room.id ? room : tab)
        : [...current, room]
    ))
  }, [availableContextRooms])

  useEffect(() => {
    const open = (event: Event) => {
      const room = (event as CustomEvent<ContextRoomWorkspaceTab>).detail
      if (room?.id && room.title) openContextRoomTab(room)
    }
    window.addEventListener('nxcore:room:open', open as EventListener)
    return () => window.removeEventListener('nxcore:room:open', open as EventListener)
  }, [openContextRoomTab])

  useEffect(() => {
    if (activePage !== 'settings') {
      manualMemoryOnboardingRef.current = false
      setSuppressRoomOnboarding(false)
    }
  }, [activePage])

  useEffect(() => {
    const onAccountChanged = (event: Event) => {
      const authenticated = (event as CustomEvent<{ authenticated?: unknown }>).detail?.authenticated === true
      logOnboarding('account-status', { authenticated })
      if (!authenticated) {
        fullOnboardingCompletedRef.current = readFullOnboardingCompleted()
        fullOnboardingStageRef.current = 'idle'
        setFullOnboardingStage('idle')
        setFolderOnboardingOpen(false)
        setMemoryReady(false)
        setSuppressRoomOnboarding(false)
        manualMemoryOnboardingRef.current = false
        return
      }
    }
    const checkAutomaticOnboarding = async () => {
      const requestId = ++onboardingCheckRequestRef.current
      logOnboarding('post-login-check', { completed: fullOnboardingCompletedRef.current })
      setSuppressAutomaticOnboarding(true)
      setSuppressRoomOnboarding(true)
      setFolderOnboardingOpen(false)
      if (fullOnboardingCompletedRef.current) return

      const memoryApi = window.nxcore?.memory
      const roomApi = window.nxcore?.contextRooms
      const sourcesApi = window.nxcore?.sources
      const apisAvailable = Boolean(memoryApi?.overview && roomApi?.list && sourcesApi?.list)
      const [memoryResult, roomsResult, sourcesResult] = await Promise.allSettled([
        memoryApi?.overview() ?? Promise.resolve(null),
        roomApi?.list() ?? Promise.resolve(null),
        sourcesApi?.list() ?? Promise.resolve(null),
      ])
      if (requestId !== onboardingCheckRequestRef.current) return

      const failed = [memoryResult, roomsResult, sourcesResult].some((result) => result?.status === 'rejected')
      const memoryOverview = memoryResult?.status === 'fulfilled' ? memoryResult.value : null
      const roomSnapshot = roomsResult?.status === 'fulfilled' ? roomsResult.value : null
      const sources = sourcesResult?.status === 'fulfilled' ? sourcesResult.value : null
      const hasData = hasExistingOnboardingData({
        memoryOverview,
        roomCount: roomSnapshot?.rooms.length ?? 0,
        deletedRoomCount: roomSnapshot?.deletedRooms.length ?? 0,
        sourceCount: Array.isArray(sources) ? sources.length : 0,
      })
      logOnboarding('data-check-complete', { failed, hasData })
      if (hasData) {
        completeAutomaticOnboarding()
        return
      }
      // Do not interrupt an established workspace merely because one service
      // was temporarily unavailable during the first-use check.
      if (failed || !apisAvailable) return

      setCompletedOnboardingStages(new Set())
      fullOnboardingStageRef.current = 'folder'
      setFullOnboardingStage('folder')
      setFolderOnboardingOpen(true)
      setMemoryReady(false)
      setSuppressAutomaticOnboarding(false)
      setSuppressRoomOnboarding(false)
      setActivePage('settings')
    }
    const onPostLogin = () => { void checkAutomaticOnboarding() }
    const onRuntimeConfigStatus = (event: Event) => {
      if ((event as CustomEvent<string>).detail === 'ready') void checkAutomaticOnboarding()
    }
    window.addEventListener('everroom-account-status-changed', onAccountChanged)
    window.addEventListener('everroom-post-login-onboarding-check', onPostLogin)
    window.addEventListener('everroom-runtime-config-status', onRuntimeConfigStatus)
    void checkAutomaticOnboarding()
    return () => {
      onboardingCheckRequestRef.current += 1
      window.removeEventListener('everroom-account-status-changed', onAccountChanged)
      window.removeEventListener('everroom-post-login-onboarding-check', onPostLogin)
      window.removeEventListener('everroom-runtime-config-status', onRuntimeConfigStatus)
    }
  }, [completeAutomaticOnboarding])

  useEffect(() => {
    if (fullOnboardingStage !== 'room') return
    setActivePage('settings')
    let attempts = 0
    let timer: number | null = null
    const openWhenReady = () => {
      const openRoomOnboarding = openRoomOnboardingRef.current
      if (openRoomOnboarding) {
        openRoomOnboarding()
        return
      }
      if (attempts >= 10) return
      attempts += 1
      timer = window.setTimeout(openWhenReady, 0)
    }
    openWhenReady()
    return () => {
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [fullOnboardingStage])

  const switchOnboardingStage = useCallback((stage: OnboardingFlowStage) => {
    logOnboarding('stage-change-request', {
      from: fullOnboardingStageRef.current,
      to: stage,
      activePage,
    })
    if (stage === 'idle') return
    fullOnboardingStageRef.current = stage
    setFullOnboardingStage(stage)
    setFolderOnboardingOpen(stage === 'folder' || stage === 'ready')
    setActivePage('settings')
    if (stage === 'memory') {
      setSuppressRoomOnboarding(true)
      openRoomOnboardingRef.current = null
      openMemoryOnboardingRef.current?.()
    } else if (stage === 'room') {
      setSuppressRoomOnboarding(false)
    } else {
      setSuppressRoomOnboarding(false)
    }
  }, [])

  useEffect(() => {
    if (fullOnboardingCompletedRef.current) return
    if (fullOnboardingStage !== 'folder' && fullOnboardingStage !== 'ready') return
    setActivePage('settings')
    setFolderOnboardingOpen(true)
  }, [fullOnboardingStage])

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
    const nextTabs = contextRoomTabs.filter((tab) => tab.id !== roomId)
    setContextRoomTabs(nextTabs)
    if (activeContextRoomId === roomId) {
      setActiveContextRoomId(nextTabs[closingIndex]?.id ?? nextTabs[closingIndex - 1]?.id ?? null)
    }
  }, [activeContextRoomId, contextRoomTabs])

  // 文件页打开 Office 预览 → 顶栏新标签（同文件复用标签），焦点切到该预览。
  const openOfficeTab = useCallback((tab: OfficePreviewTab) => {
    setOfficeTabs((current) => (
      current.some((item) => item.id === tab.id)
        ? current.map((item) => item.id === tab.id ? tab : item)
        : [...current, tab]
    ))
    setActiveOfficeInstanceId(tab.id)
    setActivePage('office-document')
  }, [])

  const activateOfficeTab = useCallback((instanceId: string) => {
    setActiveOfficeInstanceId(instanceId)
    setActivePage('office-document')
  }, [])

  const closeOfficeTab = useCallback((instanceId: string) => {
    void window.nxcore?.office.closeInstance(instanceId).catch((error) => {
      console.error('Failed to close the Office preview.', error)
    })
    const closingIndex = officeTabs.findIndex((tab) => tab.id === instanceId)
    if (closingIndex < 0) return
    const nextTabs = officeTabs.filter((tab) => tab.id !== instanceId)
    setOfficeTabs(nextTabs)
    if (activeOfficeInstanceId !== instanceId) return
    const neighbor = nextTabs[closingIndex] ?? nextTabs[closingIndex - 1] ?? null
    if (neighbor) {
      setActiveOfficeInstanceId(neighbor.id)
      return
    }
    setActiveOfficeInstanceId(null)
    setActivePage('files')
  }, [activeOfficeInstanceId, officeTabs])

  const syncContextRoomTabs = useCallback((rooms: ContextRoomWorkspaceTab[]) => {
    const roomById = new Map(rooms.map((room) => [room.id, room]))
    setContextRoomTabs((current) => current.flatMap((tab) => {
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

  useEffect(() => window.nxcore?.notifications.onOpenTarget((target) => {
    void window.nxcore?.account.status({ quiet: true }).then((account) => {
      if (account.device?.id !== target.sourceDeviceId) {
        setRemoteNotificationTarget(target)
        return
      }
      setRemoteNotificationTarget(null)
      setAgentOpen(true)
      setAgentSessionRouteRequest({
        key: `notification:${target.notificationId}`,
        pageId: target.roomId ? 'rooms' : 'home',
        roomId: target.roomId,
        sessionId: target.sessionId,
        runId: target.runId,
      })
      if (target.roomId) {
        setActivePage('rooms')
        setActiveContextRoomId(target.roomId)
      } else {
        setActivePage('home')
        setActiveContextRoomId(null)
      }
    }).catch(() => setRemoteNotificationTarget(target))
  }), [])

  return (
    // 启动 gate（最外层）：未配置 AI runtime config 时先登录/手动配置，
    // 连通测试通过才进入后续 onboarding 与应用。
    <RuntimeConfigGate>
    <OnboardingFlowChrome stage={fullOnboardingStage} completedStages={completedOnboardingStages} onStageChange={switchOnboardingStage}>
    <MemoryOnboardingGate activeStage={fullOnboardingStage} suppressOnboarding={suppressAutomaticOnboarding} onMemoryGenerated={setGeneratedMemoryNotice} onFinished={() => {
      logOnboarding('memory-finished', {
        stage: fullOnboardingStageRef.current,
        destination: 'room',
      })
      setMemoryReady(true)
      markOnboardingStageCompleted('memory')
      if (fullOnboardingStageRef.current !== 'memory') return
      manualMemoryOnboardingRef.current = false
      fullOnboardingStageRef.current = 'room'
      setFullOnboardingStage('room')
      setFolderOnboardingOpen(false)
      setSuppressRoomOnboarding(false)
      setActivePage('settings')
    }} onExistingData={completeAutomaticOnboarding} onNavigateStage={switchOnboardingStage}>
      {({ openMemoryOnboarding }) => {
      openMemoryOnboardingRef.current = openMemoryOnboarding
      return (
      <RoomOnboardingGate
        activeStage={fullOnboardingStage}
        suppressOnboarding={suppressRoomOnboarding || suppressAutomaticOnboarding}
        onExistingData={completeAutomaticOnboarding}
        onNavigateStage={switchOnboardingStage}
        memoryReady={memoryReady}
        onFinished={() => {
          logOnboarding('room-finished', {
            stage: fullOnboardingStageRef.current,
            destination: 'ready',
          })
          // 'room' = manual full-onboarding restart from Settings; 'idle' =
          // natural first run, where the gates open themselves and the stage
          // machine is never advanced. Both paths must reach folder consent,
          // including the existing-room path so permissions can be confirmed.
          if (fullOnboardingStageRef.current !== 'room' && fullOnboardingStageRef.current !== 'idle') return
          markOnboardingStageCompleted('room')
          fullOnboardingStageRef.current = 'ready'
          setFullOnboardingStage('ready')
          setFolderOnboardingOpen(true)
        }}
      >
      {({ openRoomOnboarding }) => {
        openRoomOnboardingRef.current = openRoomOnboarding
        return (
      <>
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
        officeTabs={officeTabs}
        activeOfficeId={activeWorkspaceOfficeId}
        agentOpen={agentOpen}
        navCollapsed={effectiveNavCollapsed}
        onActivateWorkbench={() => {
          if (activePage === 'rooms' && activeContextRoomId) showContextRoomHome()
          // 预览无「主页」可回：点工作区标签时退回文件页（预览入口），标签保留。
          if (activePage === 'office-document' || activePage === 'office-test') setActivePage('files')
        }}
        onActivateContextRoom={activateContextRoomTab}
        onCloseContextRoom={closeContextRoomTab}
        onActivateOfficeTab={activateOfficeTab}
        onCloseOfficeTab={closeOfficeTab}
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
          memoryFocusId={memoryFocusId}
          contextRoomHomeRequest={contextRoomHomeRequest}
          onContextRoomDetailFocusChange={handleContextRoomDetailFocusChange}
          onContextRoomOpenTab={openContextRoomTab}
          onContextRoomRoomsChange={syncContextRoomTabs}
          onContextRoomShowHome={showContextRoomHome}
          onNavigate={navigate}
          onFocusAgent={focusAgent}
          onOpenDocument={openDocumentTarget}
          onOpenOfficePreview={openOfficeTab}
          onStartFullOnboarding={() => {
            logOnboarding('manual-full-onboarding-start', { destination: 'folder' })
            if (agentNavigationTimerRef.current !== null) {
              window.clearTimeout(agentNavigationTimerRef.current)
              agentNavigationTimerRef.current = null
            }
            manualMemoryOnboardingRef.current = true
            fullOnboardingCompletedRef.current = false
            setCompletedOnboardingStages(new Set())
            setSuppressAutomaticOnboarding(false)
            setMemoryReady(false)
            fullOnboardingStageRef.current = 'folder'
            // Memory onboarding temporarily unmounts the nested Room gate.
            // Do not call the opener captured from that old instance later.
            openRoomOnboardingRef.current = null
            setFullOnboardingStage('folder')
            setSuppressRoomOnboarding(false)
            setActiveContextRoomId(null)
            setAgentNavigationRequest(null)
            setAgentSessionRouteRequest(null)
            setAgentDocumentFocus(null)
            setActivePage('settings')
            setFolderOnboardingOpen(true)
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
          onRestoreRoomTab={restoreContextRoomTab}
          onNavigationConsumed={(key) => setAgentNavigationRequest((current) => current?.key === key ? null : current)}
          onOpenSessionLink={openAgentSessionLink}
          onOpenDocument={openDocumentTarget}
          onSessionRouteConsumed={(key) => setAgentSessionRouteRequest((current) => current?.key === key ? null : current)}
          focusRequest={agentFocusRequest}
          roomCitations={agentRoomCitations}
          onRemoveRoomCitation={(citationId) => {
            clearRoomOverviewCitation(citationId)
            setAgentRoomCitations((current) => current.filter((citation) => citation.id !== citationId))
          }}
          onClearRoomCitations={() => {
            agentRoomCitations.forEach((citation) => clearRoomOverviewCitation(citation.id))
            setAgentRoomCitations([])
          }}
        />
      ) : null}
      <HighRiskImportReview />
      <AppToast />
      <AppErrorDialog />
      {remoteNotificationTarget ? (
        <RemoteAgentNotificationView target={remoteNotificationTarget} onClose={() => setRemoteNotificationTarget(null)} />
      ) : null}
      {generatedMemoryNotice ? (
        <section className="memory-generated-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-generated-dialog-title">
          <div className="memory-generated-dialog-mark" aria-hidden="true"><BrainCircuit /></div>
          <button
            type="button"
            className="memory-generated-dialog-close"
            title={t('memory:onboarding.dismissNotification')}
            aria-label={t('memory:onboarding.dismissNotification')}
            onClick={() => setGeneratedMemoryNotice(null)}
          ><X aria-hidden="true" /></button>
          <span className="memory-generated-dialog-eyebrow">{t('memory:onboarding.memorySetup')}</span>
          <h2 id="memory-generated-dialog-title">{t('memory:onboarding.backgroundMemoryReadyTitle')}</h2>
          <p>{t('memory:onboarding.backgroundMemoryReadyBody')}</p>
          <blockquote>{generatedMemoryNotice.content}</blockquote>
          <button
            type="button"
            className="memory-generated-dialog-action"
            onClick={() => {
              setMemoryFocusId(generatedMemoryNotice.id)
              setGeneratedMemoryNotice(null)
              navigate('memory')
            }}
          >{t('memory:onboarding.viewMemory')}<ArrowRight aria-hidden="true" /></button>
        </section>
      ) : null}
      </div>
      <FolderSettingsOnboarding
        open={folderOnboardingOpen}
        memoryReady={memoryReady}
        showReady={fullOnboardingStage === 'ready'}
        onNavigateStage={switchOnboardingStage}
        onClose={() => {
          setFolderOnboardingOpen(false)
          const currentStage = fullOnboardingStageRef.current
          const isFinalReady = fullOnboardingStage === 'ready' || currentStage === 'ready'
          logOnboarding('folder-close', {
            stage: fullOnboardingStage,
            stageRef: currentStage,
            isFinalReady,
            destination: isFinalReady ? 'home' : 'memory',
          })
          if (!isFinalReady && currentStage === 'folder') {
            markOnboardingStageCompleted('folder')
            fullOnboardingStageRef.current = 'memory'
            setFullOnboardingStage('memory')
            setSuppressRoomOnboarding(true)
            openMemoryOnboardingRef.current?.()
          } else {
            markOnboardingStageCompleted('folder')
            writeFullOnboardingCompleted()
            fullOnboardingCompletedRef.current = true
            fullOnboardingStageRef.current = 'idle'
            setFullOnboardingStage('idle')
            setSuppressAutomaticOnboarding(true)
            manualMemoryOnboardingRef.current = false
            setSuppressRoomOnboarding(false)
            setActivePage('home')
          }
        }}
      />
      </>
      )
      }}
      </RoomOnboardingGate>
      )}}
    </MemoryOnboardingGate>
    </OnboardingFlowChrome>
    </RuntimeConfigGate>
  )
}
