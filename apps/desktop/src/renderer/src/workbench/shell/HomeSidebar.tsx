import {
  Bot,
  ChevronsUpDown,
  ChevronRight,
  Clock,
  FolderOpen,
  LayoutGrid,
  LogOut,
  Plug,
  Settings,
  Sparkles,
  UserRound,
} from 'lucide-react'
import React, { useCallback, useEffect, useState } from 'react'

import everroomAppIcon from '@/assets/everroom-app-icon.png'
import { formatCredits } from '@/shared/sources'
import { useOptionalAccount } from '@/state/AccountContext'

import { useHomeTab, useWorkbenchStore } from '../state/store'
import type { HomePageKey } from '../types'
import { cn } from '../ui/cn'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu'
import { PlanUpgradeModal } from './PlanUpgradeModal'

const NAV_ITEMS: ReadonlyArray<{ key: HomePageKey; label: string; icon: React.ReactNode }> = [
  { key: 'recent', label: '最近', icon: <Clock size={16} strokeWidth={1.8} /> },
  { key: 'spaces', label: '项目空间', icon: <LayoutGrid size={16} strokeWidth={1.8} /> },
  { key: 'files', label: '所有文件', icon: <FolderOpen size={16} strokeWidth={1.8} /> },
  { key: 'agent', label: 'Agent', icon: <Bot size={16} strokeWidth={1.8} /> },
  { key: 'skills', label: '技能', icon: <Sparkles size={16} strokeWidth={1.8} /> },
  { key: 'connectors', label: '连接器', icon: <Plug size={16} strokeWidth={1.8} /> },
  { key: 'settings', label: '设置', icon: <Settings size={16} strokeWidth={1.8} /> },
]

/**
 * 主页标签的全局侧栏：品牌 + 一级入口 + 账户。
 *
 * - 设置是独立的一级页面，排在「连接器」下面，不再藏在账户行后面。
 * - 账户行只表示身份，点开是账号菜单：档位+升级 / 积分余额 / 账号与同步 / 退出登录。
 */
export function HomeSidebar() {
  const homeTab = useHomeTab()
  const openHome = useWorkbenchStore((state) => state.openHome)
  const openSettings = useWorkbenchStore((state) => state.openSettings)

  const accountState = useOptionalAccount()
  const account = accountState?.account ?? null
  const signedIn = account?.authenticated === true
  const accountName = account?.user?.name || account?.user?.email || account?.user?.phone || null
  const accountLabel = signedIn ? (accountName ?? '已登录') : '未登录'
  const accountHint = signedIn ? (account?.subscription?.planName ?? 'EverRoom 账号') : '登录后同步项目空间'
  const avatarText = signedIn && accountName ? accountName.trim().slice(0, 1).toUpperCase() : '登'
  const planCode = signedIn ? (account?.subscription?.planCode ?? null) : null
  const isPro = planCode === 'pro' && ['active', 'trialing'].includes(account?.subscription?.status ?? '')

  const [loggingOut, setLoggingOut] = useState(false)
  const [upgradeOpen, setUpgradeOpen] = useState(false)
  // 菜单打开时拉一次总额度(remainingCredits = 周期剩余 + 充值余额,积分取整)
  const [creditsValue, setCreditsValue] = useState<number | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const refreshCredits = useCallback(() => {
    if (!signedIn || !window.nxcore?.aiRelay) return
    void window.nxcore.aiRelay.status()
      .then((status) => { if (status?.configured) setCreditsValue(status.remainingCredits) })
      .catch(() => undefined)
  }, [signedIn])

  useEffect(() => {
    if (menuOpen) refreshCredits()
  }, [menuOpen, refreshCredits])

  const openPlanSection = () => openSettings('settings-plan')

  const logout = async () => {
    if (!window.nxcore || loggingOut) return
    setLoggingOut(true)
    try {
      accountState?.setAccount(await window.nxcore.account.logout())
    } catch {
      // 主进程的请求拦截器已经提示过错误，这里只收起忙碌态。
    } finally {
      setLoggingOut(false)
    }
  }

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
              onClick={() => (item.key === 'settings' ? openSettings() : openHome(item.key))}
            >
              <span className="wb-nav-icon" aria-hidden="true">{item.icon}</span>
              <span className="wb-nav-label">{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="wb-sidebar-foot">
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger asChild>
            <button
              type="button"
              className="wb-account"
              aria-label={signedIn ? `账号：${accountLabel}` : '账号'}
              title={signedIn ? accountLabel : '登录 EverRoom 账号'}
            >
              <span className="wb-account-avatar" aria-hidden="true">{avatarText}</span>
              <span className="wb-account-text">
                <strong>{accountLabel}</strong>
                <span>{accountHint}</span>
              </span>
              <ChevronsUpDown size={13} className="wb-account-chevron" aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent side="top" align="start" sideOffset={8} className="wb-account-menu">
            {signedIn ? (
              <>
                <div className="wb-account-plan" role="group" aria-label="当前套餐">
                  <UserRound size={14} aria-hidden="true" />
                  <strong>{isPro ? 'Pro' : 'Free'}</strong>
                  {isPro ? null : (
                    <button type="button" className="wb-account-plan-upgrade" onClick={() => setUpgradeOpen(true)}>
                      升级
                    </button>
                  )}
                </div>
                <button type="button" className="wb-account-credits" onClick={openPlanSection}>
                  <Sparkles size={14} aria-hidden="true" />
                  <strong>积分余额</strong>
                  <span className="wb-account-credits-value">
                    {creditsValue === null ? '…' : formatCredits(creditsValue, 'en')}
                  </span>
                  <ChevronRight size={13} aria-hidden="true" />
                </button>
                <MenuSeparator />
              </>
            ) : null}
            <MenuItem icon={<UserRound size={14} />} onSelect={() => openSettings('settings-account')}>
              {signedIn ? '账号与同步' : '登录账号'}
            </MenuItem>
            {signedIn ? (
              <>
                <MenuSeparator />
                <MenuItem icon={<LogOut size={14} />} danger disabled={loggingOut} onSelect={() => { void logout() }}>
                  {loggingOut ? '正在退出…' : '退出登录'}
                </MenuItem>
              </>
            ) : null}
          </MenuContent>
        </Menu>
      </div>

      <PlanUpgradeModal
        open={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        currentPlanCode={planCode}
        onSettled={() => { void accountState?.refreshAccount?.(); refreshCredits() }}
      />
    </aside>
  )
}
