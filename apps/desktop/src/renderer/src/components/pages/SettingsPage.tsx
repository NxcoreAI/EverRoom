import {
  Apple,
  Brain,
  CalendarClock,
  Cloud,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  RefreshCw,
  Settings,
  ShieldCheck,
  WalletCards,
  type LucideIcon,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { useAccount } from '@/state/AccountContext'
import type { CloudOidcProvider } from '../../../../shared/sources'
import { PageHeader } from './PageHeader'
import './SettingsPage.css'

const SETTINGS: Array<{ icon: LucideIcon; title: string; description: string }> = [
  { icon: HardDrive, title: '本地数据', description: '数据目录、备份与保留策略' },
  { icon: Brain, title: '模型与记忆', description: '模型供应商、Embedding 与记忆治理' },
  { icon: ShieldCheck, title: '隐私与权限', description: '外发范围、审批和审计记录' },
  { icon: Settings, title: '通用', description: '语言、启动行为与界面偏好' },
]

type PendingAction = CloudOidcProvider | 'password' | 'refresh' | 'logout' | null

function formatMinutes(seconds: number): string {
  return `${Math.floor(seconds / 60).toLocaleString('zh-CN')} 分钟`
}

function formatPeriodEnd(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

export function SettingsPage() {
  const { account, refreshAccount, setAccount } = useAccount()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState<PendingAction>(null)

  const loginWithOidc = async (provider: CloudOidcProvider) => {
    if (!window.nxcore) return
    setPending(provider)
    try {
      setAccount(await window.nxcore.account.loginWithOidc(provider))
    } catch {
      // The preload request interceptor reports the error globally.
    } finally {
      setPending(null)
    }
  }

  const loginWithPassword = async (event: FormEvent) => {
    event.preventDefault()
    if (!window.nxcore) return
    setPending('password')
    try {
      setAccount(await window.nxcore.account.login({ identifier, password }))
      setPassword('')
    } catch {
      // The preload request interceptor reports the error globally.
    } finally {
      setPending(null)
    }
  }

  const refreshAccountStatus = async () => {
    if (!window.nxcore) return
    setPending('refresh')
    try {
      await refreshAccount()
    } catch {
      // The preload request interceptor reports the error globally.
    } finally {
      setPending(null)
    }
  }

  const logout = async () => {
    if (!window.nxcore) return
    setPending('logout')
    try {
      setAccount(await window.nxcore.account.logout())
    } catch {
      // The preload request interceptor reports the error globally.
    } finally {
      setPending(null)
    }
  }

  const isBusy = pending !== null
  const accountName = account?.user?.email
    || account?.user?.name
    || account?.user?.phone
    || 'EverRoom 用户'

  return (
    <div className="page settings-page">
      <PageHeader title="设置" description="管理本地工作区、云端账号和数据边界。" />

      <section className="cloud-account-section" aria-labelledby="cloud-account-title">
        <header className="cloud-account-header">
          <span className="cloud-account-icon"><Cloud aria-hidden="true" /></span>
          <div>
            <h2 id="cloud-account-title">EverRoom 账号</h2>
            <p>{account?.authenticated ? '云端服务已连接' : '登录后使用订阅额度与托管转写'}</p>
          </div>
          <div className="cloud-account-header-actions">
            {account?.authenticated ? (
              <button
                className="cloud-account-refresh"
                type="button"
                disabled={isBusy}
                aria-label="刷新账号与额度"
                title="刷新账号与额度"
                onClick={() => void refreshAccountStatus()}
              >
                <RefreshCw className={pending === 'refresh' ? 'spin' : undefined} aria-hidden="true" />
              </button>
            ) : null}
            <span className="cloud-account-state" data-connected={String(Boolean(account?.authenticated))}>
              <span aria-hidden="true" />
              {account === null ? '正在检查' : account.authenticated ? '已连接' : '未登录'}
            </span>
          </div>
        </header>

        {account?.authenticated ? (
          <div className="cloud-account-connected">
            <div className="cloud-account-session">
              <span className="cloud-account-avatar" aria-hidden="true">
                {accountName.slice(0, 1).toUpperCase()}
              </span>
              <div className="cloud-account-identity">
                <strong>{accountName}</strong>
                <span>{account.user?.name && account.user.name !== accountName
                  ? account.user.name
                  : account.user?.phone || '已通过 Logto 验证'}</span>
                <small>{account.apiBaseUrl}</small>
              </div>
              <button className="secondary-button" type="button" disabled={isBusy} onClick={logout}>
                {pending === 'logout'
                  ? <LoaderCircle className="spin" aria-hidden="true" />
                  : <LogOut aria-hidden="true" />}
                退出登录
              </button>
            </div>

            {account.subscription ? (
              <div className="cloud-subscription">
                <div className="cloud-subscription-plan">
                  <span><WalletCards aria-hidden="true" />当前套餐</span>
                  <strong>{account.subscription.planName}</strong>
                  <small>{account.subscription.status === 'active' ? '订阅生效中' : account.subscription.status}</small>
                </div>
                <div className="cloud-subscription-quota">
                  <div>
                    <span>剩余转写额度</span>
                    <strong>{formatMinutes(account.subscription.remainingSeconds)}</strong>
                  </div>
                  <progress
                    aria-label="本周期转写额度用量"
                    max={Math.max(1, account.subscription.quotaSeconds)}
                    value={Math.min(account.subscription.usedSeconds, account.subscription.quotaSeconds)}
                  />
                  <small>
                    已用 {formatMinutes(account.subscription.usedSeconds)} / 共 {formatMinutes(account.subscription.quotaSeconds)}
                  </small>
                </div>
                <div className="cloud-subscription-period">
                  <span><CalendarClock aria-hidden="true" />本周期截止</span>
                  <strong>{formatPeriodEnd(account.subscription.periodEnd)}</strong>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="cloud-login-content">
            <div className="social-login-grid" aria-label="快捷登录">
              <button
                className="social-login-button apple-login"
                type="button"
                disabled={isBusy}
                onClick={() => loginWithOidc('apple')}
              >
                {pending === 'apple'
                  ? <LoaderCircle className="spin" aria-hidden="true" />
                  : <Apple aria-hidden="true" />}
                使用 Apple 登录
              </button>
              <button
                className="social-login-button google-login"
                type="button"
                disabled={isBusy}
                onClick={() => loginWithOidc('google')}
              >
                {pending === 'google'
                  ? <LoaderCircle className="spin" aria-hidden="true" />
                  : <span className="google-mark" aria-hidden="true">G</span>}
                使用 Google 登录
              </button>
            </div>

            <p className="oidc-login-note">
              <LockKeyhole aria-hidden="true" />
              {pending === 'apple' || pending === 'google'
                ? '请在系统浏览器中完成登录，完成后会自动返回 EverRoom。'
                : '登录将在系统浏览器中安全完成。'}
            </p>

            <div className="cloud-login-divider"><span>或使用账号密码</span></div>

            <form className="cloud-login-form" onSubmit={loginWithPassword}>
              <label>
                <span>邮箱或手机号</span>
                <input
                  autoComplete="username"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  required
                />
              </label>
              <label>
                <span>密码</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
              <button
                className="primary-button"
                type="submit"
                disabled={isBusy || !identifier.trim() || !password}
              >
                {pending === 'password'
                  ? <LoaderCircle className="spin" aria-hidden="true" />
                  : <LogIn aria-hidden="true" />}
                登录
              </button>
            </form>
          </div>
        )}
      </section>

      <div className="settings-list">
        {SETTINGS.map(({ icon: Icon, title, description }) => (
          <button key={title} type="button" className="settings-row">
            <span className="item-icon"><Icon aria-hidden="true" strokeWidth={1.8} /></span>
            <span><strong>{title}</strong><small>{description}</small></span>
          </button>
        ))}
      </div>
    </div>
  )
}
