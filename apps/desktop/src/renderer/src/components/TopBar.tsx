import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  LockKeyhole,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react'

import type { ContextRoomWorkspaceTab } from '@/components/context-room/contextRoomTabs'
import { ProductBrand } from '@/components/ui/ProductBrand'

export function TopBar({
  contextRoomTabs,
  activeContextRoomId,
  agentOpen,
  navCollapsed,
  onActivateWorkbench,
  onActivateContextRoom,
  onCloseContextRoom,
  onRestoreContextRoom,
  canRestoreContextRoom,
  onToggleAgent,
  onToggleNav,
}: {
  contextRoomTabs: ContextRoomWorkspaceTab[]
  activeContextRoomId: string | null
  agentOpen: boolean
  navCollapsed: boolean
  onActivateWorkbench: () => void
  onActivateContextRoom: (roomId: string) => void
  onCloseContextRoom: (roomId: string) => void
  onRestoreContextRoom: () => void
  canRestoreContextRoom: boolean
  onToggleAgent: () => void
  onToggleNav: () => void
}) {
  return (
    <header className="topbar">
      <div className="brand-area">
        <ProductBrand className="topbar-brand" />
        <button
          className="icon-button no-drag nav-collapse"
          type="button"
          title={navCollapsed ? '展开导航' : '收起导航'}
          aria-label={navCollapsed ? '展开导航' : '收起导航'}
          onClick={onToggleNav}
        >
          {navCollapsed ? <ChevronRight aria-hidden="true" strokeWidth={1.8} /> : <ChevronLeft aria-hidden="true" strokeWidth={1.8} />}
        </button>
      </div>

      <div className="tabs" role="tablist" aria-label="打开的页面">
        <div
          className="tab"
          data-active={String(activeContextRoomId === null)}
          data-page="home"
          role="tab"
          aria-label="工作台"
          aria-selected={activeContextRoomId === null}
        >
          <button type="button" onClick={onActivateWorkbench}>
            <LayoutGrid aria-hidden="true" strokeWidth={1.8} />
            <span>工作台</span>
            <LockKeyhole className="tab-lock" aria-hidden="true" strokeWidth={1.8} />
          </button>
        </div>
        {contextRoomTabs.map((room) => {
          const isActive = activeContextRoomId === room.id
          return (
            <div
              key={room.id}
              className="tab"
              data-active={String(isActive)}
              data-room-id={room.id}
              role="tab"
              aria-label={room.title}
              aria-selected={isActive}
            >
              <button type="button" onClick={() => onActivateContextRoom(room.id)}>
                <BookOpen aria-hidden="true" strokeWidth={1.8} />
                <span>{room.title}</span>
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`关闭 ${room.title}`}
                onClick={() => onCloseContextRoom(room.id)}
              >
                <X aria-hidden="true" strokeWidth={1.8} />
              </button>
            </div>
          )
        })}
      </div>

      <div className="top-actions no-drag">
        <button type="button" className="icon-button" title="新建标签" aria-label="新建标签">
          <Plus aria-hidden="true" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="恢复已关闭"
          aria-label="恢复已关闭"
          disabled={!canRestoreContextRoom}
          onClick={onRestoreContextRoom}
        >
          <RotateCcw aria-hidden="true" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={agentOpen ? '收起 Agent' : '展开 Agent'}
          aria-label={agentOpen ? '收起 Agent' : '展开 Agent'}
          onClick={onToggleAgent}
        >
          {agentOpen ? <PanelRightClose aria-hidden="true" strokeWidth={1.8} /> : <PanelRightOpen aria-hidden="true" strokeWidth={1.8} />}
        </button>
      </div>
    </header>
  )
}
