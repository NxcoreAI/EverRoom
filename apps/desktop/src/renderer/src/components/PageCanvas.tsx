import { lazy, Suspense } from 'react'

import type { PageId } from '@/data/navigation'
import type { ContextRoomWorkspaceTab } from './context-room/contextRoomTabs'
import { ContextRoomHomeSkeleton } from './context-room/ContextRoomHomeSkeleton'
import { DiaryPageSkeleton } from './diary/DiaryPageSkeleton'
import { DocsPage } from './pages/DocsPage'
import { HomePage } from './pages/HomePage'
import { MemoryPage } from './pages/MemoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { SourcesPage } from './pages/SourcesPage'
import { TasksPage } from './pages/TasksPage'

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
  contextRoomHomeRequest,
  onContextRoomDetailFocusChange,
  onContextRoomOpenTab,
  onContextRoomRoomsChange,
  onContextRoomShowHome,
  onNavigate,
  onFocusAgent,
}: {
  page: PageId
  activeContextRoomId: string | null
  contextRoomHomeRequest: number
  onContextRoomDetailFocusChange: (focused: boolean) => void
  onContextRoomOpenTab: (room: ContextRoomWorkspaceTab) => void
  onContextRoomRoomsChange: (rooms: ContextRoomWorkspaceTab[]) => void
  onContextRoomShowHome: () => void
  onNavigate: (page: PageId) => void
  onFocusAgent: () => void
}) {
  let content = null
  if (page === 'home') content = <HomePage onNavigate={onNavigate} onFocusAgent={onFocusAgent} />
  if (page === 'rooms') {
    content = (
      <Suspense fallback={<ContextRoomHomeSkeleton />}>
        <ContextRoomPage
          activeRoomId={activeContextRoomId}
          homeRequest={contextRoomHomeRequest}
          onDetailFocusChange={onContextRoomDetailFocusChange}
          onOpenRoomTab={onContextRoomOpenTab}
          onRoomsChange={onContextRoomRoomsChange}
          onShowHome={onContextRoomShowHome}
        />
      </Suspense>
    )
  }
  if (page === 'docs') content = <DocsPage />
  if (page === 'sources') content = <SourcesPage />
  if (page === 'memory') content = <MemoryPage />
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
      <div className="reality-page-host" hidden={page !== 'recording'}>
        <Suspense fallback={<div className="page"><div className="evidence-viewer-state">正在加载智能感知...</div></div>}>
          <RealityPage onOpenSettings={() => onNavigate('settings')} />
        </Suspense>
      </div>
      {page === 'recording' ? null : content}
    </>
  )
}
