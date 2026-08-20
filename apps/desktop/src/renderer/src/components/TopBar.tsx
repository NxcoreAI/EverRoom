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
import { useLocale } from '@/i18n/LocaleContext'

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
  const { t } = useLocale()
  return (
    <header className="topbar">
      <div className="brand-area">
        <ProductBrand className="topbar-brand" />
        <button
          className="icon-button no-drag nav-collapse"
          type="button"
          title={t(navCollapsed ? 'surface:topBar.expandNavigation' : 'surface:topBar.collapseNavigation')}
          aria-label={t(navCollapsed ? 'surface:topBar.expandNavigation' : 'surface:topBar.collapseNavigation')}
          onClick={onToggleNav}
        >
          {navCollapsed ? <ChevronRight aria-hidden="true" strokeWidth={1.8} /> : <ChevronLeft aria-hidden="true" strokeWidth={1.8} />}
        </button>
      </div>

      <div className="tabs" role="tablist" aria-label={t('surface:topBar.openPages')}>
        <div
          className="tab"
          data-active={String(activeContextRoomId === null)}
          data-page="home"
          role="tab"
          aria-label={t('surface:topBar.workspace')}
          aria-selected={activeContextRoomId === null}
        >
          <button type="button" onClick={onActivateWorkbench}>
            <LayoutGrid aria-hidden="true" strokeWidth={1.8} />
            <span>{t('surface:topBar.workspace')}</span>
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
                aria-label={t('surface:topBar.closeTitle', { title: room.title })}
                onClick={() => onCloseContextRoom(room.id)}
              >
                <X aria-hidden="true" strokeWidth={1.8} />
              </button>
            </div>
          )
        })}
      </div>

      <div className="top-actions no-drag">
        <button type="button" className="icon-button" title={t('surface:topBar.newTab')} aria-label={t('surface:topBar.newTab')}>
          <Plus aria-hidden="true" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={t('surface:topBar.restoreClosedTab')}
          aria-label={t('surface:topBar.restoreClosedTab')}
          disabled={!canRestoreContextRoom}
          onClick={onRestoreContextRoom}
        >
          <RotateCcw aria-hidden="true" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={t(agentOpen ? 'surface:topBar.collapseAgent' : 'surface:topBar.expandAgent')}
          aria-label={t(agentOpen ? 'surface:topBar.collapseAgent' : 'surface:topBar.expandAgent')}
          onClick={onToggleAgent}
        >
          {agentOpen ? <PanelRightClose aria-hidden="true" strokeWidth={1.8} /> : <PanelRightOpen aria-hidden="true" strokeWidth={1.8} />}
        </button>
      </div>
    </header>
  )
}
