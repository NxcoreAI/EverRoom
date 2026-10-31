import {
  Bot,
  Clock,
  FolderOpen,
  LayoutGrid,
  Plug,
  Settings,
} from 'lucide-react'
import React, { useMemo } from 'react'

import everroomAppIcon from '@/assets/everroom-app-icon.png'
import { useOptionalAccount } from '@/state/AccountContext'

import { useHomeTab, useWorkbenchStore } from '../state/store'
import type { HomePageKey } from '../types'
import { cn } from '../ui/cn'

const NAV_ITEMS: ReadonlyArray<{ key: Exclude<HomePageKey, 'settings'>; label: string; icon: React.ReactNode }> = [
  { key: 'recent', label: '最近', icon: <Clock size={16} strokeWidth={1.8} /> },
  { key: 'spaces', label: '项目空间', icon: <LayoutGrid size={16} strokeWidth={1.8} /> },
  { key: 'files', label: '所有文件', icon: <FolderOpen size={16} strokeWidth={1.8} /> },
  { key: 'agent', label: 'Agent', icon: <Bot size={16} strokeWidth={1.8} /> },
  { key: 'connectors', label: '连接器', icon: <Plug size={16} strokeWidth={1.8} /> },
]

/** 主页标签的全局侧栏：品牌 + 一级入口 + 账户。工作空间标签会换成另一条侧栏。 */
export function HomeSidebar() {
  const homeTab = useHomeTab()
  const openHome = useWorkbenchStore((state) => state.openHome)

  const accountState = useOptionalAccount()
  const account = accountState?.account ?? null
  const signedIn = account?.authenticated === true
  const accountName = account?.user?.name || account?.user?.email || account?.user?.phone || null
  const accountLabel = signedIn ? (accountName ?? '已登录') : '未登录'
  const accountHint = signedIn ? (account?.subscription?.planName ?? '账户与设置') : '登录后同步空间'
  const avatarText = signedIn && accountName ? accountName.trim().slice(0, 1).toUpperCase() : '登'

  return (
    <aside className="wb-sidebar" aria-label="主导航">
      <div className="wb-sidebar-titlebar" aria-hidden="true" />
      <div className="wb-sidebar-brand">
        <img className="wb-sidebar-brand-mark" src={everroomAppIcon} alt="" aria-hidden="true" draggable={false} />
        <div className="wb-sidebar-brand-text">
          <strong>EverRoom</strong>
          <span>Agent 工作台</span>
        </div>
      </div>

      <nav className="wb-sidebar-nav" aria-label="主页入口">
        {NAV_ITEMS.map((item) => {
          const active = homeTab.page === item.key
          return (
            <button
              key={item.key}
              type="button"
              className={cn('wb-nav-item', active && 'is-active')}
              aria-current={active ? 'page' : undefined}
              onClick={() => openHome(item.key)}
            >
              <span className="wb-nav-icon" aria-hidden="true">{item.icon}</span>
              <span className="wb-nav-label">{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="wb-sidebar-foot">
        <button
          type="button"
          className={cn('wb-account', homeTab.page === 'settings' && 'is-active')}
          title="账户与设置"
          onClick={() => openHome('settings')}
        >
          <span className="wb-account-avatar" aria-hidden="true">{avatarText}</span>
          <span className="wb-account-text">
            <strong>{accountLabel}</strong>
            <span>{accountHint}</span>
          </span>
          <Settings size={14} className="wb-account-gear" aria-hidden="true" />
        </button>
      </div>
    </aside>
  )
}
