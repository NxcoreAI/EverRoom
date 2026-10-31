import {
  FilePlus2,
  Home,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  SquarePen,
  X,
} from 'lucide-react'
import React, { useEffect, useRef } from 'react'

import { WindowControls } from '@/components/WindowControls'
import { FileTypeIcon } from '@/office-proto/pages/parts'

import { HOME_TAB_ID, type FileTab, type WindowTab, type WorkspaceTab, tabTitle } from '../types'
import { useWorkbenchStore } from '../state/store'
import { Hint, IconButton } from '../ui/primitives'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu'
import { cn } from '../ui/cn'

/** 标签栏：窗口最顶层。主页标签固定最左；工作空间/文件标签可关；右侧是全局动作与窗口按钮。 */
export function TabBar() {
  const tabs = useWorkbenchStore((state) => state.tabs)
  const activeTabId = useWorkbenchStore((state) => state.activeTabId)
  const workspaces = useWorkbenchStore((state) => state.workspaces)
  const activateTab = useWorkbenchStore((state) => state.activateTab)
  const requestCloseTab = useWorkbenchStore((state) => state.requestCloseTab)
  const toggleSidebar = useWorkbenchStore((state) => state.toggleSidebar)
  const sidebarCollapsed = useWorkbenchStore((state) => state.sidebarCollapsed)
  const createSession = useWorkbenchStore((state) => state.createSession)
  const openHome = useWorkbenchStore((state) => state.openHome)

  const activeWorkspaceTab = tabs.find((tab) => tab.id === activeTabId && tab.kind === 'workspace')
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  // 文件标签没有侧栏，收起按钮在那里只会是个「点了没反应」的死按钮：直接不渲染。
  const hasSidebar = activeTab !== null && activeTab.kind !== 'file'

  const closeTab = (event: React.MouseEvent, id: string) => {
    event.stopPropagation()
    void requestCloseTab(id)
  }

  return (
    <div className="wb-tabbar">
      {/* 侧栏开关放左侧（应用惯例位置）；文件标签没有侧栏时保留同宽占位，避免标签栏横跳。 */}
      <div className="wb-tabbar-left">
        <span className="wb-sidebar-toggle-slot">
          {hasSidebar ? (
            <Hint label={sidebarCollapsed ? '展开侧栏（⌘B）' : '收起侧栏（⌘B）'}>
              <IconButton
                label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
                icon={sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
                active={!sidebarCollapsed}
                aria-expanded={!sidebarCollapsed}
                onClick={() => toggleSidebar()}
              />
            </Hint>
          ) : null}
        </span>
      </div>

      <button
        type="button"
        className={cn('wb-tab wb-tab--home', activeTabId === HOME_TAB_ID && 'is-active')}
        onClick={() => activateTab(HOME_TAB_ID)}
        title="主页"
      >
        <Home size={15} strokeWidth={1.9} aria-hidden="true" />
        <span className="wb-tab-name">主页</span>
      </button>

      <div className="wb-tablist" role="tablist" aria-label="打开的标签页">
        {tabs.filter((tab) => tab.kind !== 'home').map((tab) => (
          <WindowTabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            title={tabTitle(tab, workspaces)}
            onActivate={() => activateTab(tab.id)}
            onClose={(event) => closeTab(event, tab.id)}
          />
        ))}
      </div>

      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="wb-tab-add" title="新建" aria-label="新建">
            <Plus size={16} strokeWidth={1.9} />
          </button>
        </MenuTrigger>
        <MenuContent align="start" side="bottom" className="wb-new-menu">
          <MenuItem
            icon={<SquarePen size={14} />}
            onSelect={() => {
              const workspaceId = activeWorkspaceTab?.kind === 'workspace'
                ? activeWorkspaceTab.workspaceId
                : null
              if (workspaceId) void createSession(workspaceId)
              else window.dispatchEvent(new CustomEvent('everroom:workbench-new-space'))
            }}
          >
            新建工作
          </MenuItem>
          <MenuItem
            icon={<LayoutGrid size={14} />}
            onSelect={() => window.dispatchEvent(new CustomEvent('everroom:workbench-new-space'))}
          >
            新建项目空间
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<FilePlus2 size={14} />}
            onSelect={() => openHome('files')}
          >
            浏览文件库
          </MenuItem>
        </MenuContent>
      </Menu>

      <div className="wb-tabbar-spacer" aria-hidden="true" />

      <div className="wb-tabbar-actions">
        <Hint label="搜索（⌘K）">
          <IconButton
            label="搜索"
            icon={<Search size={15} />}
            onClick={() => window.dispatchEvent(new CustomEvent('everroom:workbench-search'))}
          />
        </Hint>
        <WindowControls />
      </div>
    </div>
  )
}

function WindowTabButton({ tab, active, title, onActivate, onClose }: {
  tab: WorkspaceTab | FileTab
  active: boolean
  title: string
  onActivate: () => void
  onClose: (event: React.MouseEvent) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // 激活标签滚进可视区（标签多到溢出时）。
  useEffect(() => {
    if (!active) return
    ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={cn('wb-tab', 'wb-tab--page', active && 'is-active')}
      title={title}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onActivate()
        }
      }}
      onAuxClick={(event) => {
        if (event.button === 1) onClose(event)
      }}
    >
      <span className="wb-tab-icon" aria-hidden="true">
        {tab.kind === 'workspace'
          ? <LayoutGrid size={15} strokeWidth={1.9} />
          : <FileTypeIcon kind={tab.file.kind} size={17} />}
      </span>
      <span className="wb-tab-name">{title}</span>
      <button
        type="button"
        className="wb-tab-close"
        aria-label={`关闭 ${title}`}
        title="关闭标签"
        onClick={onClose}
      >
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  )
}
