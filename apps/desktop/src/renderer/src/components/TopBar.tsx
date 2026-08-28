import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  LayoutGrid,
  LockKeyhole,
  PanelRightClose,
  PanelRightOpen,
  Presentation,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { ContextRoomWorkspaceTab } from '@/components/context-room/contextRoomTabs'
import { ProductBrand } from '@/components/ui/ProductBrand'
import { useLocale } from '@/i18n/LocaleContext'
import type { OfficePreviewKind, OfficePreviewTab } from '../../../shared/sources'

const officeTabIcons: Record<OfficePreviewKind, LucideIcon> = {
  docx: FileText,
  spreadsheet: FileSpreadsheet,
  slides: Presentation,
}

export function TopBar({
  contextRoomTabs,
  activeContextRoomId,
  officeTabs,
  activeOfficeId,
  agentOpen,
  navCollapsed,
  onActivateWorkbench,
  onActivateContextRoom,
  onCloseContextRoom,
  onActivateOfficeTab,
  onCloseOfficeTab,
  onToggleAgent,
  onToggleNav,
}: {
  contextRoomTabs: ContextRoomWorkspaceTab[]
  activeContextRoomId: string | null
  officeTabs: OfficePreviewTab[]
  activeOfficeId: string | null
  agentOpen: boolean
  navCollapsed: boolean
  onActivateWorkbench: () => void
  onActivateContextRoom: (roomId: string) => void
  onCloseContextRoom: (roomId: string) => void
  onActivateOfficeTab: (instanceId: string) => void
  onCloseOfficeTab: (instanceId: string) => void
  onToggleAgent: () => void
  onToggleNav: () => void
}) {
  const { t } = useLocale()
  const workbenchActive = activeContextRoomId === null && activeOfficeId === null
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
          data-active={String(workbenchActive)}
          data-page="home"
          role="tab"
          aria-label={t('surface:topBar.workspace')}
          aria-selected={workbenchActive}
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
        {officeTabs.map((tab) => {
          const isActive = activeOfficeId === tab.id
          const OfficeIcon = officeTabIcons[tab.kind]
          // 内嵌 Office 预览一律只读，标签名带上 [只读] 前缀。
          const readOnlyTitle = t('surface:topBar.officeReadOnly', { title: tab.title })
          return (
            <div
              key={tab.id}
              className="tab"
              data-active={String(isActive)}
              data-office-id={tab.id}
              role="tab"
              aria-label={readOnlyTitle}
              aria-selected={isActive}
            >
              <button type="button" onClick={() => onActivateOfficeTab(tab.id)}>
                <OfficeIcon aria-hidden="true" strokeWidth={1.8} />
                <span>{readOnlyTitle}</span>
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={t('surface:topBar.closeTitle', { title: tab.title })}
                onClick={() => onCloseOfficeTab(tab.id)}
              >
                <X aria-hidden="true" strokeWidth={1.8} />
              </button>
            </div>
          )
        })}
      </div>

      <div className="top-actions no-drag">
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
