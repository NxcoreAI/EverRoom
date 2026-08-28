import { lazy, Suspense } from 'react'

import type { PageId } from '@/data/navigation'
import type { ContextRoomWorkspaceTab } from './context-room/contextRoomTabs'
import { ContextRoomHomeSkeleton } from './context-room/ContextRoomHomeSkeleton'
import { DiaryPageSkeleton } from './diary/DiaryPageSkeleton'
import { DocsPage } from './pages/DocsPage'
import { FilesPage } from './pages/FilesPage'
import { InspirationPage } from './pages/InspirationPage'
import { HomePage } from './pages/HomePage'
import { MemoryPage } from './pages/MemoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { SourcesPage } from './pages/SourcesPage'
import { WikiPage } from './pages/WikiPage'
import { ConnectorSyncPage } from './pages/ConnectorSyncPage'
import { AgentStatusPage } from './pages/AgentStatusPage'
import { AgentSchedulesPage } from './pages/AgentSchedulesPage'
import { useLocale } from '@/i18n/LocaleContext'

const ContextRoomPage = lazy(() =>
  import('./context-room/ContextRoomPage').then((module) => ({ default: module.ContextRoomPage })),
)
const DiaryPage = lazy(() =>
  import('./diary/DiaryPage').then((module) => ({ default: module.DiaryPage })),
)
const RealityPage = lazy(() =>
  import('./reality/RealityPage').then((module) => ({ default: module.RealityPage })),
)

export function PageCanvas({
  page,
  activeContextRoomId,
  agentDocumentFocus,
  contextRoomHomeRequest,
  onContextRoomDetailFocusChange,
  onContextRoomOpenTab,
  onContextRoomRoomsChange,
  onContextRoomShowHome,
  onNavigate,
  onFocusAgent,
  onOpenDocument,
  memoryFocusId,
  onStartFullOnboarding,
}: {
  page: PageId
  activeContextRoomId: string | null
  agentDocumentFocus: {
    roomId: string
    documentId: string
    blockId?: string | null
    requestId: number
  } | null
  contextRoomHomeRequest: number
  onContextRoomDetailFocusChange: (focused: boolean) => void
  onContextRoomOpenTab: (room: ContextRoomWorkspaceTab) => void
  onContextRoomRoomsChange: (rooms: ContextRoomWorkspaceTab[]) => void
  onContextRoomShowHome: () => void
  onNavigate: (page: PageId) => void
  onFocusAgent: () => void
  onOpenDocument: (target: { roomId: string; documentId: string; blockId?: string | null }) => void
  memoryFocusId?: string | null
  onStartFullOnboarding?: () => void
}) {
  const { t } = useLocale()
  let content = null
  if (page === 'home') content = <HomePage onNavigate={onNavigate} onFocusAgent={onFocusAgent} onOpenDocument={onOpenDocument} />
  if (page === 'office') content = <AgentStatusPage />
  if (page === 'office-document' || page === 'office-test') {
    content = (
      <div className="page">
        <div className="evidence-viewer-state">{page === 'office-test' ? '正在加载 DOCX 测试文档…' : '正在加载 Office 文档…'}</div>
      </div>
    )
  }
  if (page === 'schedules') content = <AgentSchedulesPage />
  if (page === 'rooms') {
    content = (
      <Suspense fallback={<ContextRoomHomeSkeleton />}>
        <ContextRoomPage
          activeRoomId={activeContextRoomId}
          focusedDocumentId={agentDocumentFocus?.roomId === activeContextRoomId
            ? agentDocumentFocus.documentId
            : null}
          focusedBlockId={agentDocumentFocus?.roomId === activeContextRoomId
            ? agentDocumentFocus.blockId ?? null
            : null}
          documentFocusRequestId={agentDocumentFocus?.roomId === activeContextRoomId
            ? agentDocumentFocus.requestId
            : null}
          homeRequest={contextRoomHomeRequest}
          onDetailFocusChange={onContextRoomDetailFocusChange}
          onOpenRoomTab={onContextRoomOpenTab}
          onRoomsChange={onContextRoomRoomsChange}
          onShowHome={onContextRoomShowHome}
          onFocusAgent={onFocusAgent}
        />
      </Suspense>
    )
  }
  if (page === 'docs') content = <DocsPage onNavigate={onNavigate} onOpenDocument={onOpenDocument} />
  if (page === 'sources') content = <SourcesPage />
  if (page === 'files') content = <FilesPage onNavigate={onNavigate} />
  if (page === 'inspiration') content = <InspirationPage />
  if (page === 'memory') content = <MemoryPage focusAtomicId={memoryFocusId} />
  if (page === 'wiki') content = <WikiPage />
  if (page === 'connectors') content = <ConnectorSyncPage />
  if (page === 'diary') {
    content = (
      <Suspense fallback={<DiaryPageSkeleton />}>
        <DiaryPage
          onNavigate={onNavigate}
          onOpenDocument={onOpenDocument}
          onFocusRealityEvent={(eventId) => window.dispatchEvent(new CustomEvent('nxcore:reality:focus-event', { detail: { eventId } }))}
        />
      </Suspense>
    )
  }
  if (page === 'settings') content = <SettingsPage onStartFullOnboarding={onStartFullOnboarding} />
  return (
    <>
      <div
        className="reality-page-host workspace-page-transition"
        data-page="recording"
        hidden={page !== 'recording'}
      >
        <Suspense fallback={<div className="page"><div className="evidence-viewer-state">{t('surface:pageCanvas.loadingPerception')}</div></div>}>
          <RealityPage onOpenSettings={() => onNavigate('settings')} />
        </Suspense>
      </div>
      {page === 'recording' ? null : (
        <div key={page} className="workspace-page-transition" data-page={page}>
          {content}
        </div>
      )}
    </>
  )
}
