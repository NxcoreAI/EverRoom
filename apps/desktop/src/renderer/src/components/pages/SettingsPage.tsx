import {
  AudioLines,
  Brain,
  CalendarClock,
  Cloud,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  Laptop,
  Mic,
  MonitorSpeaker,
  RefreshCw,
  Settings,
  ShieldCheck,
  Smartphone,
  WalletCards,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'

import { useAccount } from '@/state/AccountContext'
import { loadRealitySettings, saveRealitySettings, type RealitySettings } from '@/state/realitySettings'
import appleLogo from '@/assets/apple-logo.svg'
import googleLogo from '@/assets/google-logo.svg'
import type { CloudOidcProvider } from '../../../../shared/sources'
import type { AccountKeyringStatus, CloudDevice } from '../../../../shared/sources'
import { PageHeader } from './PageHeader'
import './SettingsPage.css'

const SETTINGS: Array<{ icon: LucideIcon; title: string; description: string }> = [
  { icon: HardDrive, title: '本地数据', description: '数据目录、备份与保留策略' },
  { icon: Brain, title: '模型与记忆', description: '模型供应商、Embedding 与记忆治理' },
  { icon: ShieldCheck, title: '隐私与权限', description: '外发范围、审批和审计记录' },
  { icon: Settings, title: '通用', description: '语言、启动行为与界面偏好' },
]

type PendingAction = CloudOidcProvider | 'password' | 'refresh' | 'logout' | 'keyring' | 'sync' | null
type PairingSession = { pairingSessionId: string; pairingToken?: string; status: string; confirmationCode: string; expiresAt: string; origin?: string; targetDeviceId?: string | null; targetDeviceName?: string | null; targetPublicKey?: string | null }

function formatMinutes(seconds: number, rounding: 'down' | 'up' = 'down'): string {
  const minutes = rounding === 'up' ? Math.ceil(seconds / 60) : Math.floor(seconds / 60)
  return `${minutes.toLocaleString('zh-CN')} 分钟`
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

function deviceLastSeen(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '最近在线时间未知'
  return `最近在线 ${date.toLocaleString('zh-CN')}`
}

export function SettingsPage() {
  const { account, refreshAccount, setAccount } = useAccount()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState<PendingAction>(null)
  const [realitySettings, setRealitySettings] = useState<RealitySettings>(loadRealitySettings)
  const [keyring, setKeyring] = useState<AccountKeyringStatus | null>(null)
  const [syncedCount, setSyncedCount] = useState<number | null>(null)
  const [syncedAudioCount, setSyncedAudioCount] = useState<number | null>(null)
  const [devices, setDevices] = useState<CloudDevice[]>([])
  const [pairing, setPairing] = useState<PairingSession | null>(null)
  const [pairingQr, setPairingQr] = useState<string | null>(null)
  const [pairingError, setPairingError] = useState<string | null>(null)

  useEffect(() => {
    if (!account?.authenticated || !window.nxcore) {
      setKeyring(null)
      setDevices([])
      return
    }
    const desktopApi = window.nxcore
    let cancelled = false
    const check = async () => {
      try {
        const [next, nextDevices] = await Promise.all([
          desktopApi.account.keyringStatus({ quiet: true }),
          desktopApi.account.devices({ quiet: true }),
        ])
        if (cancelled) return
        setKeyring(next)
        setDevices(nextDevices)
      } catch {
        // Keep the last known status during transient network or rate-limit failures.
      } finally {
        setPending((current) => current === 'keyring' ? null : current)
      }
    }
    setPending('keyring')
    void check()
    const timer = window.setInterval(() => void check(), 15_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [account?.authenticated, account?.user?.id])

  useEffect(() => {
    if (!pairing || !window.nxcore) return
    let cancelled = false
    const poll = async () => {
      if (cancelled) return
      try {
        const next = await window.nxcore!.account.getPairingSession(pairing.pairingSessionId, { quiet: true })
        if (!cancelled) setPairing((current) => current ? { ...current, ...next } : current)
      } catch (error) {
        if (error instanceof Error && error.message.includes('请求过于频繁')) return
        cancelled = true
        setPairingError(`${error instanceof Error ? error.message : '配对会话读取失败。'} 请重启 SaaS 服务后重新创建二维码。`)
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [pairing?.pairingSessionId])

  const createPairing = async () => {
    if (!window.nxcore) return
    setPairingError(null)
    try {
      const session = await window.nxcore.account.createPairingSession()
      const payload = JSON.stringify({ version: 1, origin: session.origin, pairingSessionId: session.pairingSessionId, pairingToken: session.pairingToken })
      const dataUrl = await QRCode.toDataURL(payload, { margin: 1, width: 220, errorCorrectionLevel: 'M' })
      setPairingQr(dataUrl)
      setPairing(session)
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : '无法创建配对会话。')
    }
  }

  const resetPairing = () => {
    setPairing(null)
    setPairingQr(null)
    setPairingError(null)
  }

  const approvePairing = async () => {
    if (!window.nxcore || !pairing) return
    setPending('keyring')
    try {
      await window.nxcore.account.approvePairingSession(pairing.pairingSessionId)
      setPairingError(null)
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : '批准设备失败。')
    } finally { setPending(null) }
  }

  const updateRealitySettings = (patch: Partial<RealitySettings>) => {
    setRealitySettings((current) => {
      const next = { ...current, ...patch }
      saveRealitySettings(next)
      return next
    })
  }

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

  const syncPrivate = async () => {
    if (!window.nxcore) return
    setPending('sync')
    try {
      const [result, audio] = await Promise.all([
        window.nxcore.transcriptions.syncPrivate(),
        window.nxcore.privateAudio.list(0),
      ])
      setKeyring(result.status)
      setSyncedCount(result.synced)
      setSyncedAudioCount(audio.assets.filter((asset) => asset.status === 'uploaded').length)
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
                    <strong>{formatMinutes(account.subscription.remainingSeconds, 'up')}</strong>
                  </div>
                  <progress
                    aria-label="本周期剩余转写额度"
                    max={Math.max(1, account.subscription.quotaSeconds)}
                    value={Math.min(
                      Math.max(0, account.subscription.remainingSeconds),
                      account.subscription.quotaSeconds,
                    )}
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

            <div className="cloud-devices" aria-label="已绑定设备">
              <div className="cloud-devices-heading">
                <div>
                  <strong>已绑定设备</strong>
                  <small>{devices.length ? `${devices.length} 台设备可同步私密数据` : '正在读取设备列表'}</small>
                </div>
                <Laptop aria-hidden="true" />
              </div>
              {devices.length ? (
                <div className="cloud-device-list">
                  {devices.map((device) => {
                    const isCurrent = device.id === account.device?.id
                    const isOnline = device.status === 'online'
                    return (
                      <div key={device.id} className="cloud-device-row">
                        <span className="cloud-device-icon" aria-hidden="true">
                          {device.platform.toLowerCase().includes('ios') ? <Smartphone /> : <Laptop />}
                        </span>
                        <div className="cloud-device-info">
                          <strong>{device.name || (device.platform.toLowerCase().includes('ios') ? 'iPhone' : 'Mac')}</strong>
                          <span>{device.platform}{device.appVersion ? ` · v${device.appVersion}` : ''}{isCurrent ? ' · 本机' : ''}</span>
                        </div>
                        <div className="cloud-device-status" data-online={String(isOnline)}>
                          <span aria-hidden="true" />
                          <small>{isOnline ? '在线' : '离线'}</small>
                          <em>{deviceLastSeen(device.lastSeenAt)}</em>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : <small className="cloud-device-empty">暂未找到已绑定设备</small>}
            </div>

            <div className="cloud-keyring" aria-label="云端同步">
              <div className="cloud-keyring-heading">
                <span><ShieldCheck aria-hidden="true" /></span>
                <div>
                  <strong>云端同步</strong>
                  <small>在已登录设备间同步录音、转写和总结</small>
                </div>
              </div>
              <button
                className="secondary-button cloud-keyring-sync"
                type="button"
                disabled={isBusy}
                onClick={() => void syncPrivate()}
              >
                {pending === 'sync' ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                同步多端数据
              </button>
              {syncedCount !== null ? <small className="cloud-keyring-result">本次同步 {syncedCount} 条转写，发现 {syncedAudioCount ?? 0} 个音频片段</small> : null}
            </div>
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
                <span className="brand-login-icon" aria-hidden="true">
                  {pending === 'apple'
                    ? <LoaderCircle className="spin" />
                    : <img src={appleLogo} alt="" />}
                </span>
                通过 Apple 登录
              </button>
              <button
                className="social-login-button google-login"
                type="button"
                disabled={isBusy}
                onClick={() => loginWithOidc('google')}
              >
                <span className="brand-login-icon" aria-hidden="true">
                  {pending === 'google'
                    ? <LoaderCircle className="spin" />
                    : <img src={googleLogo} alt="" />}
                </span>
                使用 Google 账号登录
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

      <section className="reality-settings-section" aria-labelledby="reality-settings-title">
        <header>
          <span><AudioLines aria-hidden="true" /></span>
          <div>
            <h2 id="reality-settings-title">智能感知</h2>
            <p>配置聆听时使用的音源与转写方式。</p>
          </div>
        </header>
        <div className="reality-setting-row">
          <div><strong>转写服务</strong><small>自动模式会在登录后优先使用 SaaS。</small></div>
          <div className="segmented-control" aria-label="智能感知转写服务">
            {([['auto', '自动'], ['cloud', 'SaaS'], ['local', '本地']] as const).map(([value, label]) => (
              <button key={value} type="button" data-active={String(realitySettings.mode === value)} disabled={value === 'cloud' && !account?.authenticated} onClick={() => updateRealitySettings({ mode: value })}>{label}</button>
            ))}
          </div>
        </div>
        <div className="reality-setting-row">
          <div><strong>录制来源</strong><small>电脑音频需要 macOS 系统授权。</small></div>
          <div className="segmented-control reality-source-setting" aria-label="智能感知录制来源">
            <button type="button" data-active={String(realitySettings.audioSource === 'microphone')} onClick={() => updateRealitySettings({ audioSource: 'microphone' })}><Mic aria-hidden="true" />麦克风</button>
            <button type="button" data-active={String(realitySettings.audioSource === 'system')} disabled={window.nxcore?.platform !== 'darwin'} onClick={() => updateRealitySettings({ audioSource: 'system' })}><MonitorSpeaker aria-hidden="true" />电脑音频</button>
          </div>
        </div>
        <div className="reality-setting-row">
          <div><strong>转写语言</strong><small>至少保留一种主要语言。</small></div>
          <div className="segmented-control" aria-label="智能感知转写语言">
            {([['zh', '中文'], ['en', 'English']] as const).map(([value, label]) => {
              const active = realitySettings.languages.includes(value)
              return <button key={value} type="button" data-active={String(active)} onClick={() => updateRealitySettings({ languages: active && realitySettings.languages.length > 1 ? realitySettings.languages.filter((item) => item !== value) : active ? realitySettings.languages : [...realitySettings.languages, value] })}>{label}</button>
            })}
          </div>
        </div>
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
