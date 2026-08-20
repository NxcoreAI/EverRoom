import { lazy, Suspense } from 'react'

import type { PageId } from '@/data/navigation'
import type { ContextRoomWorkspaceTab } from './context-room/contextRoomTabs'
import { ContextRoomHomeSkeleton } from './context-room/ContextRoomHomeSkeleton'
import { DiaryPageSkeleton } from './diary/DiaryPageSkeleton'
import { DocsPage } from './pages/DocsPage'
import { FilesPage } from './pages/FilesPage'
import { HomePage } from './pages/HomePage'
import { MemoryPage } from './pages/MemoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { SourcesPage } from './pages/SourcesPage'
import { TasksPage } from './pages/TasksPage'
import { WikiPage } from './pages/WikiPage'
import { ConnectorSyncPage } from './pages/ConnectorSyncPage'
import { AgentStatusPage } from './pages/AgentStatusPage'
import { OfficePage } from './pages/OfficePage'

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
  onStartMemoryOnboarding,
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
  onStartMemoryOnboarding?: () => void
}) {
  let content = null
  if (page === 'home') content = <HomePage onNavigate={onNavigate} onFocusAgent={onFocusAgent} />
  if (page === 'office') content = <OfficePage onNavigate={onNavigate} onFocusAgent={onFocusAgent} />
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
  if (page === 'files') content = <FilesPage />
  if (page === 'memory') content = <MemoryPage onStartOnboarding={onStartMemoryOnboarding} />
  if (page === 'wiki') content = <WikiPage />
  if (page === 'connectors') content = <ConnectorSyncPage />
  if (page === 'agents') content = <AgentStatusPage onFocusAgent={onFocusAgent} />
  if (page === 'tasks') content = <TasksPage />
  if (page === 'diary') {
    content = (
      <Suspense fallback={<DiaryPageSkeleton />}>
        <DiaryPage />
      </Suspense>
    )
  }
  if (page === 'settings') content = <SettingsPage />
  return (
    <>
      <div
        className="reality-page-host workspace-page-transition"
        data-page="recording"
        hidden={page !== 'recording'}
      >
        <Suspense fallback={<div className="page"><div className="evidence-viewer-state">正在加载现实感知...</div></div>}>
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
