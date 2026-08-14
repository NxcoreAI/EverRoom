import { lazy, Suspense } from 'react'

import type { PageId } from '@/data/navigation'
import type { ContextRoomWorkspaceTab } from './context-room/contextRoomTabs'
import { DocsPage } from './pages/DocsPage'
import { HomePage } from './pages/HomePage'
import { MemoryPage } from './pages/MemoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { SourcesPage } from './pages/SourcesPage'
import { TasksPage } from './pages/TasksPage'

const ContextRoomPage = lazy(() =>
  import('./context-room/ContextRoomPage').then((module) => ({ default: module.ContextRoomPage })),
)
const RecordingPage = lazy(() =>
  import('./recording/RecordingPage').then((module) => ({ default: module.RecordingPage })),
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
  if (page === 'home') return <HomePage onNavigate={onNavigate} onFocusAgent={onFocusAgent} />
  if (page === 'rooms') {
    return (
      <Suspense fallback={<div className="page"><div className="evidence-viewer-state">正在加载 Context Room...</div></div>}>
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
  if (page === 'docs') return <DocsPage />
  if (page === 'recording') return (
    <Suspense fallback={<div className="page"><div className="evidence-viewer-state">正在加载录音...</div></div>}>
      <RecordingPage onOpenSettings={() => onNavigate('settings')} />
    </Suspense>
  )
  if (page === 'sources') return <SourcesPage />
  if (page === 'memory') return <MemoryPage />
  if (page === 'tasks') return <TasksPage />
  return <SettingsPage />
}
