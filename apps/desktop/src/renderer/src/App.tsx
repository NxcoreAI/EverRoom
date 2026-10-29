import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { AgentSessionLink } from '@nxcore/agent-contract'
import { type OfficePreviewTab } from '../../shared/sources'

import { AgentPanel } from '@/components/AgentPanel'
import { SearchPalette } from '@/components/search/SearchPalette'
import { slugifyAgentToken } from '@/components/agent/agentMentions'
import type { SearchHitDto } from '../../shared/search'
import type { LocalAgentInstallation } from '@nxcore/agent-contract'
import {
  isAgentPageId,
  resolveAgentSessionLinkRoute,
  type AgentNavigationRequest,
  type AgentSessionRouteRequest,
} from '@/components/agent/agentNavigation'
import { AppErrorToast } from '@/components/AppErrorToast'
import { AppToast } from '@/components/AppToast'
import { RemoteAgentNotificationView } from '@/components/RemoteAgentNotificationView'
import { HighRiskImportReview } from '@/components/HighRiskImportReview'
import { PageCanvas } from '@/components/PageCanvas'
import { Sidebar } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import { FolderSettingsOnboarding } from '@/components/onboarding/FolderSettingsOnboarding'
import { MicrophonePermissionOnboarding } from '@/components/onboarding/MicrophonePermissionOnboarding'
import { AgentMigrationOnboarding } from '@/components/onboarding/AgentMigrationOnboarding'
import { OnboardingFlowChrome, type CompletedOnboardingStage, type OnboardingFlowStage } from '@/components/onboarding/OnboardingFlowChrome'
import { RuntimeConfigGate } from '@/components/onboarding/RuntimeConfigGate'
import {
  hasExistingOnboardingData,
  nextOnboardingProbeAction,
  onboardingProbeRetryDelayMs,
  readFullOnboardingCompleted,
  writeFullOnboardingCompleted,
} from '@/components/onboarding/fullOnboardingState'
import type { ThemeId } from '@/components/ThemeSwitcher'
import { pageLabels, type PageId } from '@/data/navigation'
import { logDocumentFocusDiagnostic, onDocumentBlockNavigation } from './components/office-editor/editor/documentBlockNavigation'
import { attachOfficeViewport } from './components/office-editor/officeViewport'
import { onDocumentOperationNavigation } from './components/office-editor/operations/documentOperationNavigation'
import { useLocale } from '@/i18n/LocaleContext'
import { showToast } from '@/state/toast'
import './App.css'
import type { AgentNotificationTarget } from '../../shared/notifications'
import type { OsOpenedDocument } from '../../shared/office'
import { isEditableOfficeDocument } from '@/lib/officeEditing'

const THEME_STORAGE_KEY = 'nxcore-ce:appearance:v1'
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

const AGENT_WIDTH_STORAGE_KEY = 'nxcore-ce:agent-width:v1'
const AGENT_WIDTH_DEFAULT = 360
const AGENT_WIDTH_MIN = 280

function readStoredAgentWidth(): number {
  try {
    const stored = Number(localStorage.getItem(AGENT_WIDTH_STORAGE_KEY))
    return Number.isFinite(stored) && stored >= AGENT_WIDTH_MIN ? stored : AGENT_WIDTH_DEFAULT
  } catch {
    return AGENT_WIDTH_DEFAULT
  }
}

function readInitialPage(): PageId {
  return 'home'
}

export function App() {
  const { t } = useLocale()
  const isMacDesktop = detectMacDesktop()
  const [activePage, setActivePage] = useState<PageId>(readInitialPage)
  const [officeTabs, setOfficeTabs] = useState<OfficePreviewTab[]>([])
  const [activeOfficeInstanceId, setActiveOfficeInstanceId] = useState<string | null>(null)
  const [agentWidth, setAgentWidth] = useState(readStoredAgentWidth)
  const [agentResizing, setAgentResizing] = useState(false)
  const [agentFocusRequest, setAgentFocusRequest] = useState(0)
  const [agentNavigationRequest, setAgentNavigationRequest] = useState<AgentNavigationRequest | null>(null)
  const [agentSessionRouteRequest, setAgentSessionRouteRequest] = useState<AgentSessionRouteRequest | null>(null)
  // displayMessage：给用户看的人话；message 仍是交给 Agent 的完整指令（不渲染成用户气泡）。
  const [agentAskRequest, setAgentAskRequest] = useState<{ key: string; message: string; displayMessage?: string } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [agentPrefillRequest, setAgentPrefillRequest] = useState<{
    key: string
    text: string
    attachment?: { fileId: string; fileName: string } | null
  } | null>(null)
  const [remoteNotificationTarget, setRemoteNotificationTarget] = useState<AgentNotificationTarget | null>(null)
  const [agentDocumentFocus, setAgentDocumentFocus] = useState<{
    documentId: string
    blockId?: string | null
    requestId: number
  } | null>(null)
  const documentFocusRequestIdRef = useRef(0)
  const agentNavigationTimerRef = useRef<number | null>(null)
  const workspaceMainRef = useRef<HTMLElement>(null)
  const [navCollapsed, setNavCollapsed] = useState(false)
  const [agentOpen, setAgentOpen] = useState(() => !window.matchMedia('(max-width: 1200px)').matches)
  const [fullOnboardingStage, setFullOnboardingStage] = useState<OnboardingFlowStage>('idle')
  const [completedOnboardingStages, setCompletedOnboardingStages] = useState<Set<CompletedOnboardingStage>>(() => new Set())
  const [folderOnboardingOpen, setFolderOnboardingOpen] = useState(false)
  const [suppressAutomaticOnboarding, setSuppressAutomaticOnboarding] = useState(true)
  const [agentFileFocus, setAgentFileFocus] = useState<{ fileId: string; requestId: number } | null>(null)
  const agentFileFocusRequestIdRef = useRef(0)
  const fullOnboardingCompletedRef = useRef(readFullOnboardingCompleted())
  const fullOnboardingStageRef = useRef<OnboardingFlowStage>('idle')
  const onboardingCheckRequestRef = useRef(0)
  const [theme] = useState<ThemeId>(readStoredTheme)

  const activeWorkspaceOfficeId = activePage === 'office-document' ? activeOfficeInstanceId : null

  // Office 预览实例激活仲裁：顶栏标签页；离开预览页时隐藏（标签与实例本体保留）。
  const focusedOfficeInstanceId = activePage === 'office-document' ? activeOfficeInstanceId : null

  useEffect(() => {
    const office = window.nxcore?.office
    if (!office) return
    void office.setActiveInstance(focusedOfficeInstanceId).catch((error) => {
      console.error('Failed to update the Office view visibility.', error)
    })
  }, [focusedOfficeInstanceId])

  // office-document 顶栏页：矩形上报与弹层遮挡显隐交给共享视口模块
  //（Room 内嵌宿主 EmbeddedOfficePreview 挂同一模块；侧栏开合等布局变化
  // 由模块内 ResizeObserver 跟随，不随 agentOpen 重挂）。
  useEffect(() => {
    if (activePage !== 'office-document' || !focusedOfficeInstanceId) return
    const workspace = workspaceMainRef.current
    if (!workspace) return
    const attachment = attachOfficeViewport(workspace)
    return () => attachment.detach()
  }, [activePage, focusedOfficeInstanceId])

  useEffect(() => {
    logOnboarding('state', {
      stage: fullOnboardingStage,
      stageRef: fullOnboardingStageRef.current,
      folderOpen: folderOnboardingOpen,
      activePage,
    })
  }, [activePage, folderOnboardingOpen, fullOnboardingStage])

  const markOnboardingStageCompleted = useCallback((stage: CompletedOnboardingStage) => {
    setCompletedOnboardingStages((current) => {
      if (current.has(stage)) return current
      return new Set([...current, stage])
    })
  }, [])

  const completeAutomaticOnboarding = useCallback(() => {
    writeFullOnboardingCompleted()
    fullOnboardingCompletedRef.current = true
    // 让在途的启动探测失效：其晚到的 'advance' 决策会把刚完成的用户拽回引导页。
    onboardingCheckRequestRef.current += 1
    fullOnboardingStageRef.current = 'idle'
    setFullOnboardingStage('idle')
    setFolderOnboardingOpen(false)
    setSuppressAutomaticOnboarding(true)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Theme persistence is optional when storage is unavailable.
    }
  }, [theme])

  useEffect(() => {
    try {
      localStorage.setItem(AGENT_WIDTH_STORAGE_KEY, String(agentWidth))
    } catch {
      // Width persistence is optional when storage is unavailable.
    }
  }, [agentWidth])

  // 对话区宽度：主区至少留 760px；窄屏（≤900px）面板为覆盖层，不提供拖拽。
  const applyAgentWidth = useCallback((raw: number) => {
    const max = Math.max(400, window.innerWidth - 760)
    setAgentWidth(Math.round(Math.max(AGENT_WIDTH_MIN, Math.min(max, raw))))
  }, [])
  const startAgentResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.matchMedia('(max-width: 1200px)').matches) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setAgentResizing(true)
    const move = (moveEvent: PointerEvent) => applyAgentWidth(window.innerWidth - moveEvent.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setAgentResizing(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const resizeAgentByKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    applyAgentWidth(agentWidth + (event.key === 'ArrowLeft' ? 16 : -16))
  }

  useEffect(() => () => {
    if (agentNavigationTimerRef.current !== null) window.clearTimeout(agentNavigationTimerRef.current)
  }, [])

  // 窄窗不再隐藏左侧栏；改为自动折叠右侧 AI 面板（用户可随时手动展开）。
  // 断点与 CSS/初始态一致取 1200px（此前 900px 低于主窗 minWidth，监听永不触发）。
  useEffect(() => {
    const compactWindow = window.matchMedia('(max-width: 1200px)')
    const collapseAgent = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setAgentOpen(false)
    }
    collapseAgent(compactWindow)
    compactWindow.addEventListener('change', collapseAgent)
    return () => compactWindow.removeEventListener('change', collapseAgent)
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
    if (agentNavigationTimerRef.current !== null) {
      window.clearTimeout(agentNavigationTimerRef.current)
      agentNavigationTimerRef.current = null
    }
    setActivePage(page)
  }

  // 统一搜索面板：⌘K/Ctrl+K 全局开关。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onAccountChanged = (event: Event) => {
      const authenticated = (event as CustomEvent<{ authenticated?: unknown }>).detail?.authenticated === true
      logOnboarding('account-status', { authenticated })
      if (!authenticated) {
        fullOnboardingCompletedRef.current = readFullOnboardingCompleted()
        fullOnboardingStageRef.current = 'idle'
        setFullOnboardingStage('idle')
        setFolderOnboardingOpen(false)
        return
      }
    }
    const checkAutomaticOnboarding = async () => {
      const requestId = ++onboardingCheckRequestRef.current
      logOnboarding('post-login-check', { completed: fullOnboardingCompletedRef.current })
      setSuppressAutomaticOnboarding(true)
      if (fullOnboardingCompletedRef.current) return

      const sourcesApi = window.nxcore?.sources
      const apisAvailable = Boolean(sourcesApi?.list)
      // Saving the runtime config restarts MemoryCore to pick up the AI env
      // (a few-second window, same as the login restart in MemoryOnboardingGate).
      // A failed probe here is usually transient: retry, and only after the
      // retries are exhausted fall back to the operable main UI — never leave
      // the first-run user on a hidden shell that only a restart would fix.
      let attempt = 0
      const probe = async (): Promise<void> => {
        attempt += 1
        const [sourcesResult] = await Promise.allSettled([sourcesApi?.list() ?? Promise.resolve(null)])
        if (requestId !== onboardingCheckRequestRef.current) return

        const failed = sourcesResult?.status === 'rejected'
        const sources = sourcesResult?.status === 'fulfilled' ? sourcesResult.value : null
        const hasData = hasExistingOnboardingData({
          sourceCount: Array.isArray(sources) ? sources.length : 0,
        })
        const action = nextOnboardingProbeAction({ failed, apisAvailable, hasData, attempt })
        logOnboarding('data-check-complete', { failed, hasData, action, attempt })
        if (action === 'complete-existing') {
          completeAutomaticOnboarding()
          return
        }
        if (action === 'retry') {
          window.setTimeout(() => { void probe() }, onboardingProbeRetryDelayMs(attempt))
          return
        }
        // 'stand-down' (services stay unreachable) and 'wait' (no preload
        // APIs): stop probing without advancing or persisting completion.
        // The stage stays where it is and any panel opened by an earlier
        // check stays open, so the user lands on either the guide or the
        // operable main UI — never a hidden shell — and later checks
        // (runtime-config ready, next login) can still run the guide.
        if (action === 'stand-down' || action === 'wait') return
        // 探测重试（撞 MemoryCore 重启窗口）期间用户可能已手动走完引导：
        // 晚到的 advance 不得把人拽回引导页。
        if (fullOnboardingCompletedRef.current) return

        setCompletedOnboardingStages(new Set())
        fullOnboardingStageRef.current = 'folder'
        setFullOnboardingStage('folder')
        setFolderOnboardingOpen(true)
        setSuppressAutomaticOnboarding(false)
        setActivePage('settings')
      }
      await probe()
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
  }, [])

  useEffect(() => {
    // While the flow chrome sits on folder/ready it hides the main app shell,
    // so the folder panel must be open. Restore it if a racing check (e.g. the
    // runtime-config-ready recheck) closed the panel but left the stage set —
    // otherwise the first-run user lands on an empty, unoperable shell.
    if (fullOnboardingStage !== 'folder' && fullOnboardingStage !== 'ready') return
    setActivePage('settings')
    setFolderOnboardingOpen(true)
  }, [fullOnboardingStage])

  // 文稿定位：Agent 建好/改动文稿后带 documentId 跳文稿库，由 DocsPage 高亮该行。
  const openDocumentTarget = useCallback((target: { documentId: string; blockId?: string | null }) => {
    setAgentDocumentFocus({
      documentId: target.documentId,
      blockId: target.blockId ?? null,
      requestId: ++documentFocusRequestIdRef.current,
    })
    navigate('docs')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => onDocumentBlockNavigation(openDocumentTarget), [openDocumentTarget])
  useEffect(() => onDocumentOperationNavigation(openDocumentTarget), [openDocumentTarget])

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

  // 系统文件管理器（访达「打开方式」/ 资源管理器双击）打开 Word/Excel/PPT：
  // 主进程已把文件导入文件库，这里复用文件页的 openOriginal，开出同一个顶栏预览标签。
  useEffect(() => {
    const files = window.nxcore?.files
    if (!files?.onOpenFromOs) return
    const openFromSystem = (document: OsOpenedDocument) => {
      const editable = isEditableOfficeDocument(document.originalName)
      void files.openOriginal(
        document.fileId,
        document.originalName,
        undefined,
        editable ? { editable: true } : undefined,
      )
        .then((result) => {
          if (result?.openedWith === 'office') {
            openOfficeTab({ id: result.instanceId, title: result.title, kind: result.kind })
            return
          }
          if (result?.openedWith === 'external' && result.legacyFallback) {
            showToast({
              title: t('surface:files.legacyPreviewFallbackTitle'),
              message: t('surface:files.legacyPreviewFallbackMessage'),
            })
          }
        })
        .catch((error) => {
          console.error('Failed to open the document from the system file manager.', error)
        })
    }
    const takePending = typeof files.takePendingOsOpen === 'function'
      ? files.takePendingOsOpen.bind(files)
      : null
    // 已消费的事件顺手清掉主进程暂存，避免下次页面重载把旧文件再打开一次。
    const unsubscribe = files.onOpenFromOs((document) => {
      openFromSystem(document)
      void takePending?.().catch(() => undefined)
    })
    // 冷启动：系统打开事件可能早于本组件挂载，取走主进程暂存的请求（取后清空）。
    void takePending?.()
      .then((document) => { if (document) openFromSystem(document) })
      .catch(() => undefined)
    return unsubscribe
  }, [openOfficeTab, t])

  const activateOfficeTab = useCallback((instanceId: string) => {
    setActiveOfficeInstanceId(instanceId)
    setActivePage('office-document')
  }, [])

  const closeOfficeTab = useCallback((instanceId: string) => {
    void window.nxcore?.office.closeInstance(instanceId)
      .then((closed) => {
        // false = 可编辑实例在脏关闭守卫里被取消：标签与实例都保留。
        if (closed === false) return
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
      })
      .catch((error) => {
        console.error('Failed to close the Office preview.', error)
      })
  }, [activeOfficeInstanceId, officeTabs])

  // Context Room 等非文件页入口的 Office 文件打开请求：走 files:open-original，
  // 内嵌预览 → 顶栏新标签；其余格式由主进程直接用系统默认应用打开。
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ fileId: string; originalName: string }>).detail
      const files = window.nxcore?.files
      if (!detail?.fileId || !files) return
      void files.openOriginal(detail.fileId, detail.originalName)
        .then((result) => {
          if (result?.openedWith === 'office') {
            openOfficeTab({ id: result.instanceId, title: result.title, kind: result.kind })
          }
        })
        .catch((error) => {
          console.error('Failed to open the Office preview.', error)
        })
    }
    window.addEventListener('nxcore:office:open', open as EventListener)
    return () => window.removeEventListener('nxcore:office:open', open as EventListener)
  }, [openOfficeTab])

  // Agent 生成 Word（office 桥）：阶段进度提示；完成后刷新 Room 清单并导航
  // 进所属 Room、右区原位打开产物（PortedDetail 消费 focus 请求）。
  useEffect(() => {
    const office = window.nxcore?.office
    if (!office?.onAgentFile) return
    return office.onAgentFile((payload) => {
      if (payload.type === 'edited') {
        // 人手编辑回填落库（版本链 +1）：静默刷新清单，不弹提示、不抢焦点。
        window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'))
        return
      }
      if (payload.type === 'write-back-failed') {
        // 库内版本已更新，但写回访达里的原文件失败：必须让用户知道外部程序看不到这次修改。
        showToast({
          title: t('surface:files.writeBackFailedTitle'),
          message: t('surface:files.writeBackFailedMessage', {
            name: payload.originalName ?? payload.title,
            error: payload.message ?? '',
          }),
          variant: 'error',
        })
        window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'))
        return
      }
      if (payload.type === 'open-edit') {
        // 桌面端 Agent 编辑未打开的产物：以可编辑方式打开 + 顶栏出标签（编辑实时可见）。
        const files = window.nxcore?.files
        if (!payload.fileId || !payload.originalName || !files) return
        void files.openOriginal(payload.fileId, payload.originalName, undefined, { editable: true })
          .then((result) => {
            if (result?.openedWith === 'office') {
              openOfficeTab({ id: result.instanceId, title: result.title, kind: result.kind })
            }
          })
          .catch((error) => {
            console.error('Failed to open the Office preview for agent edit.', error)
          })
        return
      }
      const kind = t(`surface:agentOffice.kind.${payload.format ?? 'docx'}`)
      if (payload.type === 'phase') {
        const phaseKey = payload.phase === 'rendering'
          ? 'surface:agentOffice.generating.rendering'
          : payload.phase === 'saved'
            ? 'surface:agentOffice.generating.saved'
            : 'surface:agentOffice.generating.importing'
        showToast({ title: t('surface:agentOffice.generating.title', { kind }), message: t(phaseKey, { title: payload.title }) })
        return
      }
      if (payload.type === 'error') {
        // 工具/生成失败只在对话流里就地展示（执行时间线 + PPT 进度卡），
        // 不再弹遮挡式提示框，避免盖住用户正在看的内容。
        return
      }
      // 完成提示：只有全部页落定才会收到 done（生成期 done 已由桌面端 deferDone 推迟），
      // 部分完成时如实给出页数，不把「1 页骨架」说成「已生成」。
      if (payload.partial) {
        showToast({
          title: t('surface:agentOffice.done.partialTitle', { kind }),
          message: t('surface:agentOffice.done.partialMessage', {
            title: payload.title,
            applied: payload.appliedPages ?? 0,
            total: payload.totalPages ?? 0,
          }),
        })
      } else {
        showToast({ title: t('surface:agentOffice.done.title', { kind }), message: t('surface:agentOffice.done.message', { title: payload.title }) })
      }
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'))
      // 产物库已随 Context Room 移除：生成完成后直接以顶栏标签打开该产物（可编辑——
      // 生成期间落页/fillPage 依赖可编辑实例，只读打开会把实例翻成预览导致后续落页被拒）。
      if (!payload.fileId || !payload.originalName) return
      const files = window.nxcore?.files
      if (!files) return
      void files.openOriginal(payload.fileId, payload.originalName, undefined, { editable: true })
        .then((result) => {
          if (result?.openedWith === 'office') {
            openOfficeTab({ id: result.instanceId, title: result.title, kind: result.kind })
          }
        })
        .catch((error) => {
          console.error('Failed to open the generated Office file.', error)
        })
    })
  }, [openOfficeTab, t])

  // slides「AI 修改」弹层转发（office 桥）：把组装好的修改指令自动发给 Agent
  //（AgentPanel 消费后自动发送，用户无需再敲一遍）。
  useEffect(() => {
    const office = window.nxcore?.office
    if (!office?.onAgentAsk) return
    return office.onAgentAsk((payload) => {
      setAgentOpen(true)
      setAgentAskRequest({
        key: `agent-ask-${Date.now()}`,
        message: payload.message,
        ...(payload.displayMessage ? { displayMessage: payload.displayMessage } : {}),
      })
    })
  }, [])

  const focusAgent = () => {
    setAgentOpen(true)
    setAgentFocusRequest((request) => request + 1)
  }

  /** 消息区点击 @ 的文件：跳到文件页并聚焦该文件。 */
  const openAgentMentionFile = (fileId: string) => {
    if (agentNavigationTimerRef.current !== null) {
      window.clearTimeout(agentNavigationTimerRef.current)
      agentNavigationTimerRef.current = null
    }
    setAgentFileFocus({ fileId, requestId: ++agentFileFocusRequestIdRef.current })
    navigate('files')
  }

  // ---- 统一搜索面板动作 ----
  const openSearchSession = (hit: SearchHitDto) => {
    setAgentOpen(true)
    const page = hit.pageId && isAgentPageId(hit.pageId) ? hit.pageId : 'home'
    setAgentSessionRouteRequest({
      key: `search:${hit.id}:${Date.now()}`,
      pageId: page,
      roomId: null,
      sessionId: hit.sessionId ?? hit.refId,
    })
  }

  const attachSearchHit = (hit: SearchHitDto) => {
    setAgentOpen(true)
    setAgentPrefillRequest({
      key: `search-attach-${Date.now()}`,
      text: `请参考《${hit.title}》处理。`,
      attachment: hit.itemType === 'file' ? { fileId: hit.refId, fileName: hit.title } : null,
    })
  }

  const dispatchSearchHit = (hit: SearchHitDto, agent: LocalAgentInstallation | null, instruction: string) => {
    setAgentOpen(true)
    const lead = agent ? `@${slugifyAgentToken(agent.displayName)} ` : ''
    const extra = instruction.trim() ? `\n${instruction.trim()}` : ''
    setAgentPrefillRequest({
      key: `search-dispatch-${Date.now()}`,
      text: `${lead}请处理这份材料：《${hit.title}》${extra}`,
      attachment: hit.itemType === 'file' ? { fileId: hit.refId, fileName: hit.title } : null,
    })
  }

  const navigateFromAgent = (request: AgentNavigationRequest) => {
    setAgentNavigationRequest(request)
    setAgentSessionRouteRequest(null)
    setAgentOpen(true)
    if (agentNavigationTimerRef.current !== null) window.clearTimeout(agentNavigationTimerRef.current)
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180
    agentNavigationTimerRef.current = window.setTimeout(() => {
      agentNavigationTimerRef.current = null
      const { target } = request
      // 文稿定位只对文稿库有意义：其余目标仅切换页面，不留焦在高亮上。
      setAgentDocumentFocus(target.pageId === 'docs' && target.objectType === 'document' && target.objectId
        ? {
            documentId: target.objectId,
            blockId: target.blockId ?? null,
            requestId: ++documentFocusRequestIdRef.current,
          }
        : null)
      navigate(target.pageId)
    }, delay)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }

  const openAgentSessionLink = (link: AgentSessionLink, destination: 'source' | 'target') => {
    const route = resolveAgentSessionLinkRoute(link, destination)
    if (!route) return
    if (agentNavigationTimerRef.current !== null) {
      window.clearTimeout(agentNavigationTimerRef.current)
      agentNavigationTimerRef.current = null
    }
    setAgentNavigationRequest(null)
    setAgentSessionRouteRequest(route)
    setAgentDocumentFocus(route.pageId === 'docs' && route.documentId
      ? {
          documentId: route.documentId,
          blockId: route.blockId ?? null,
          requestId: ++documentFocusRequestIdRef.current,
        }
      : null)
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
        pageId: 'home',
        roomId: null,
        sessionId: target.sessionId,
        runId: target.runId,
      })
      setActivePage('home')
    }).catch(() => setRemoteNotificationTarget(target))
  }), [])

  return (
    // 启动 gate（最外层）：未配置 AI runtime config 时先登录/手动配置，
    // 连通测试通过才进入后续 onboarding 与应用。
    <RuntimeConfigGate>
    <OnboardingFlowChrome stage={fullOnboardingStage} completedStages={completedOnboardingStages} onStageChange={switchOnboardingStage}>
      <div
      className="app-shell"
      data-agent-open={String(agentOpen)}
      data-agent-resizing={String(agentResizing)}
      data-mac-desktop={String(isMacDesktop)}
      data-nav-collapsed={String(navCollapsed)}
      style={{ '--agent-width': `${String(agentWidth)}px` } as CSSProperties}
    >
      <TopBar
        officeTabs={officeTabs}
        activeOfficeId={activeWorkspaceOfficeId}
        agentOpen={agentOpen}
        onActivateWorkbench={() => {
          // 预览无「主页」可回：点工作区标签时退回文件页（预览入口），标签保留。
          if (activePage === 'office-document') setActivePage('files')
        }}
        onActivateOfficeTab={activateOfficeTab}
        onCloseOfficeTab={closeOfficeTab}
        onToggleAgent={() => setAgentOpen((open) => !open)}
        onOpenSearch={() => setSearchOpen(true)}
      />
      <Sidebar activePage={activePage} onNavigate={navigate} />
      <main ref={workspaceMainRef} className="workspace-main">
        <PageCanvas
          page={activePage}
          agentDocumentFocus={agentDocumentFocus}
          agentFileFocus={agentFileFocus}
          onNavigate={navigate}
          onFocusAgent={focusAgent}
          onOpenOfficePreview={openOfficeTab}
          onStartFullOnboarding={() => {
            logOnboarding('manual-full-onboarding-start', { destination: 'folder' })
            if (agentNavigationTimerRef.current !== null) {
              window.clearTimeout(agentNavigationTimerRef.current)
              agentNavigationTimerRef.current = null
            }
            fullOnboardingCompletedRef.current = false
            setCompletedOnboardingStages(new Set())
            setSuppressAutomaticOnboarding(false)
            fullOnboardingStageRef.current = 'folder'
            setFullOnboardingStage('folder')
            setAgentNavigationRequest(null)
            setAgentSessionRouteRequest(null)
            setAgentDocumentFocus(null)
            setActivePage('settings')
            setFolderOnboardingOpen(true)
          }}
        />
      </main>
      {agentOpen ? (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t('surface:agentPanel.resizeWidth')}
          className="agent-panel-divider"
          onPointerDown={startAgentResize}
          onKeyDown={resizeAgentByKey}
          onFocus={() => setAgentResizing(true)}
          onBlur={() => setAgentResizing(false)}
        />
      ) : null}
      {agentOpen ? (
        <AgentPanel
          pageId={activePage}
          pageLabel={t(pageLabels[activePage])}
          navigationRequest={agentNavigationRequest}
          sessionRouteRequest={agentSessionRouteRequest}
          askRequest={agentAskRequest}
          prefillRequest={agentPrefillRequest}
          onPrefillConsumed={() => setAgentPrefillRequest(null)}
          onAskConsumed={(key) => setAgentAskRequest((current) => current?.key === key ? null : current)}
          onNavigate={navigateFromAgent}
          onNavigatePage={navigate}
          onNavigationConsumed={(key) => setAgentNavigationRequest((current) => current?.key === key ? null : current)}
          onOpenSessionLink={openAgentSessionLink}
          onSessionRouteConsumed={(key) => setAgentSessionRouteRequest((current) => current?.key === key ? null : current)}
          onOpenMentionFile={openAgentMentionFile}
          focusRequest={agentFocusRequest}
        />
      ) : null}
      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenFile={(fileId) => { openAgentMentionFile(fileId) }}
        onOpenDocument={(documentId) => { openDocumentTarget({ documentId }) }}
        onOpenSession={openSearchSession}
        onAttach={attachSearchHit}
        onDispatch={dispatchSearchHit}
      />
      <HighRiskImportReview />
      <AppToast />
      <AppErrorToast />
      {remoteNotificationTarget ? (
        <RemoteAgentNotificationView target={remoteNotificationTarget} onClose={() => setRemoteNotificationTarget(null)} />
      ) : null}
      </div>
      <FolderSettingsOnboarding
        open={folderOnboardingOpen}
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
            fullOnboardingStageRef.current = 'microphone'
            setFullOnboardingStage('microphone')
          } else {
            markOnboardingStageCompleted('folder')
            writeFullOnboardingCompleted()
            fullOnboardingCompletedRef.current = true
            // 让在途的启动探测失效：其晚到的 'advance' 决策会把刚完成的用户拽回引导页。
            onboardingCheckRequestRef.current += 1
            fullOnboardingStageRef.current = 'idle'
            setFullOnboardingStage('idle')
            setSuppressAutomaticOnboarding(true)
            setActivePage('home')
          }
        }}
      />
      {fullOnboardingStage === 'microphone' ? (
        <MicrophonePermissionOnboarding
          onNavigateStage={switchOnboardingStage}
          onFinished={() => {
            logOnboarding('microphone-finished', { stage: fullOnboardingStageRef.current })
            markOnboardingStageCompleted('microphone')
            if (fullOnboardingStageRef.current !== 'microphone') return
            fullOnboardingStageRef.current = 'agents'
            setFullOnboardingStage('agents')
          }}
        />
      ) : null}
      {fullOnboardingStage === 'agents' ? (
        <AgentMigrationOnboarding
          onNavigateStage={switchOnboardingStage}
          onFinished={() => {
            logOnboarding('agents-finished', { stage: fullOnboardingStageRef.current })
            markOnboardingStageCompleted('agents')
            if (fullOnboardingStageRef.current !== 'agents') return
            fullOnboardingStageRef.current = 'ready'
            setFullOnboardingStage('ready')
            setFolderOnboardingOpen(true)
          }}
        />
      ) : null}
    </OnboardingFlowChrome>
    </RuntimeConfigGate>
  )
}
