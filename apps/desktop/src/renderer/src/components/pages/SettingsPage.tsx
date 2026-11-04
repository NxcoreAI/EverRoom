import {
  Activity,
  Brain,
  CalendarClock,
  Cloud,
  LoaderCircle,
  Languages,
  LogOut,
  Laptop,
  Palette,
  Plug,
  RefreshCw,
  Rocket,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  Smartphone,
  WalletCards,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

import { useTranslation } from 'react-i18next'
import { useAccount } from '@/state/AccountContext'
import { ConnectorModeSection } from '@/components/settings/ConnectorModeSection'
import { UpdateSection } from '@/components/settings/UpdateSection'
import {
  loadDocumentCursorCompletionSettings,
  saveDocumentCursorCompletionSettings,
  type DocumentCursorCompletionSettings,
} from '@/state/documentCursorCompletionSettings'
import {
  loadConversationSuggestionSettings,
  saveConversationSuggestionSettings,
  type ConversationSuggestionSettings,
} from '@/state/conversationSuggestionSettings'
import appleLogo from '@/assets/apple-logo.svg'
import googleLogo from '@/assets/google-logo.svg'
import { formatCredits, type AiGatewayStatus, type CloudOidcProvider } from '../../../../shared/sources'
import type { AccountKeyringStatus, CloudDevice } from '../../../../shared/sources'
import { PageHeader } from './PageHeader'
import { McpSettingsSection } from '@/components/settings/McpSettingsSection'
import { useLocale, type AppLocale, type Translate } from '@/i18n/LocaleContext'
import { LocalAgentSettingsSection } from '@/components/settings/LocalAgentSettingsSection'
import { UsageAndBudgetSettingsSection } from '@/components/settings/UsageAndBudgetSettingsSection'
import { AppearanceSettingsSection } from '@/components/settings/AppearanceSettingsSection'
import { RuntimeConfigSettingsSection } from '@/components/settings/RuntimeConfigSettingsSection'
import { RedeemCodeField, useRedeemCode } from '@/components/account/RedeemCodeField'
import { QrLoginPanel } from '@/components/account/QrLoginPanel'
import { PlanUpgradeModal } from '@/workbench/shell/PlanUpgradeModal'
import { TopupModal } from '@/workbench/shell/TopupModal'

import './SettingsPage.css'

type SettingsNavItem = { id: string; label: string; icon: typeof Cloud }

/** 分区顺序：先「你是谁」，再「套餐与积分」，再「界面长什么样」，然后是能力（连接 / 模型 / 用量），最后是维护动作。 */
const SETTINGS_NAV: SettingsNavItem[] = [
  { id: 'settings-account', label: 'surface:settings.navigationAccount', icon: Cloud },
  { id: 'settings-plan', label: 'surface:settings.navigationPlan', icon: WalletCards },
  { id: 'settings-appearance', label: 'surface:settings.appearanceTitle', icon: Palette },
  { id: 'settings-interface', label: 'surface:settings.interfaceLanguage', icon: Languages },
  { id: 'settings-editor', label: 'surface:settings.documentEditing', icon: Sparkles },
  { id: 'settings-connector-mode', label: 'surface:settings.connectorModeTitle', icon: Plug },
  { id: 'settings-models', label: 'surface:settings.navigationModels', icon: Brain },
  { id: 'settings-runtime-config', label: 'surface:settings.navigationRuntimeConfig', icon: ShieldCheck },
  { id: 'settings-token-usage', label: 'surface:settings.usageAndBudgets', icon: Activity },
  { id: 'settings-onboarding', label: 'surface:settings.onboardingSetupTitle', icon: Rocket },
  { id: 'settings-update', label: 'surface:settings.navigationUpdate', icon: RefreshCw },
]

type PendingAction = CloudOidcProvider | 'refresh' | 'logout' | 'keyring' | 'admission' | null
type PairingSession = { pairingSessionId: string; pairingToken?: string; status: string; confirmationCode: string; expiresAt: string; origin?: string; targetDeviceId?: string | null; targetDeviceName?: string | null; targetPublicKey?: string | null }

function formatMinutes(seconds: number, locale: AppLocale, t: Translate, rounding: 'down' | 'up' = 'down'): string {
  const minutes = rounding === 'up' ? Math.ceil(seconds / 60) : Math.floor(seconds / 60)
  return t('surface:settings.minutesMinutes', { minutes: minutes.toLocaleString(locale) })
}

function formatPeriodEnd(value: string, locale: AppLocale): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function deviceLastSeen(value: string, locale: AppLocale, t: Translate): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('surface:settings.lastSeenTimeUnknown')
  return t('surface:settings.lastSeenTime', { time: date.toLocaleString(locale) })
}

function subscriptionStatusLabel(status: string, t: Translate): string {
  const labels: Record<string, string> = {
    active: 'surface:settings.subscriptionActive',
    trialing: 'surface:settings.subscriptionTrialing',
    past_due: 'surface:settings.subscriptionPastDue',
    canceled: 'surface:settings.subscriptionCanceled',
    unpaid: 'surface:settings.subscriptionUnpaid',
    incomplete: 'surface:settings.subscriptionIncomplete',
    incomplete_expired: 'surface:settings.subscriptionExpired',
    paused: 'surface:settings.subscriptionPaused',
  }
  return t(labels[status] ?? status)
}

export function SettingsPage({
  onStartFullOnboarding,
  hideHeader = false,
  section = null,
}: {
  onStartFullOnboarding?: () => void
  /** 嵌进工作台主页时由外壳提供导航，隐藏组件自带的页头（避免与侧栏/分区导航重复）。 */
  hideHeader?: boolean
  /** 外部指定要打开的分区（如账号菜单直达「账号与同步」）。 */
  section?: string | null
}) {
  const { locale, preference, setLocale, t } = useLocale()
  const { account, refreshAccount, setAccount } = useAccount()
  const [pending, setPending] = useState<PendingAction>(null)
  const [cursorCompletionSettings, setCursorCompletionSettings] =
    useState<DocumentCursorCompletionSettings>(loadDocumentCursorCompletionSettings)
  const [conversationSuggestionSettings, setConversationSuggestionSettings] =
    useState<ConversationSuggestionSettings>(loadConversationSuggestionSettings)
  const [keyring, setKeyring] = useState<AccountKeyringStatus | null>(null)
  const [devices, setDevices] = useState<CloudDevice[]>([])
  const [pairing, setPairing] = useState<PairingSession | null>(null)
  const [pairingQr, setPairingQr] = useState<string | null>(null)
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [activeSetting, setActiveSetting] = useState<string>(section ?? SETTINGS_NAV[0].id)
  const [aiRelayStatus, setAiRelayStatus] = useState<AiGatewayStatus | null>(null)
  const refreshAiRelay = useRef<(() => void) | null>(null)
  const redeemCode = useRedeemCode()
  const [qrActive, setQrActive] = useState(false)
  const [planModalOpen, setPlanModalOpen] = useState(false)
  const [topupModalOpen, setTopupModalOpen] = useState(false)

  useEffect(() => {
    if (section) setActiveSetting(section)
  }, [section])

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

  // LLM 中转余量：随订阅区拉取一次 + 额度尽事件即时刷新（保持最小 UI，无独立页面）。
  useEffect(() => {
    if (!account?.authenticated || !window.nxcore) {
      setAiRelayStatus(null)
      return
    }
    let cancelled = false
    refreshAiRelay.current = () => {
      void window.nxcore?.aiRelay.status()
        .then((status) => { if (!cancelled) setAiRelayStatus(status) })
        .catch(() => undefined)
    }
    refreshAiRelay.current()
    const removeListener = window.nxcore.aiRelay.onEvent((event) => {
      if (event.type === 'quota-exhausted') refreshAiRelay.current?.()
    })
    return () => { cancelled = true; refreshAiRelay.current = null; removeListener() }
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
        setPairingError(t('surface:settings.errorRestartTheSaasServiceThenCreateA', {
          error: error instanceof Error ? error.message : t('surface:settings.failedToLoadThePairingSession'),
        }))
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [pairing?.pairingSessionId, t])

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
      setPairingError(error instanceof Error ? error.message : t('surface:settings.failedToCreateAPairingSession'))
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
      setPairingError(error instanceof Error ? error.message : t('surface:settings.failedToApproveTheDevice'))
    } finally { setPending(null) }
  }

  const updateCursorCompletionSettings = (patch: Partial<DocumentCursorCompletionSettings>) => {
    setCursorCompletionSettings((current) => {
      const next = { ...current, ...patch }
      saveDocumentCursorCompletionSettings(next)
      return next
    })
  }

  const updateConversationSuggestionSettings = (patch: Partial<ConversationSuggestionSettings>) => {
    setConversationSuggestionSettings((current) => {
      const next = { ...current, ...patch }
      saveConversationSuggestionSettings(next)
      return next
    })
  }

  const loginWithOidc = async (provider: CloudOidcProvider) => {
    if (!window.nxcore) return
    let redeemCodeValue:string|undefined
    try { redeemCodeValue=await redeemCode.prepare() } catch { return }
    setPending(provider)
    try {
      const nextAccount=await window.nxcore.account.loginWithOidc(provider,redeemCodeValue)
      setAccount(nextAccount)
      if(redeemCodeValue&&nextAccount.registration){
        window.alert(t(nextAccount.registration.invitationRejected==='pro_plan_active'?'surface:settings.redeemCodeProActive':'surface:settings.redeemCodeApplied'))
        redeemCode.reset()
      }
      try {
        window.sessionStorage.setItem('everroom:post-login-room-check', '1')
      } catch {
        // Session storage is optional; mounted gates still receive the event.
      }
      window.dispatchEvent(new CustomEvent('everroom-post-login-onboarding-check'))
    } catch (error) {
      if(redeemCodeValue&&error instanceof Error&&/invitation code/i.test(error.message))redeemCode.markInvalid()
      // The preload request interceptor reports the error globally.
    } finally {
      setPending(null)
    }
  }

  // 已登录直接兑换：一次请求完成核验+升级，无效码/已用码标 invalid，成功后刷新订阅展示
  const redeemNow = async () => {
    if (!window.nxcore) return
    const code = redeemCode.code.trim().toUpperCase()
    if (!code) return
    try {
      const result = await window.nxcore.account.redeemInvitationCode(code)
      if (result.applied) {
        redeemCode.markDone('applied')
        await refreshAccountStatus()
        // 兑换即恢复额度：立即触发一次续签回灌槽位（relayReady 内含
        // renewNow），不等 keeper 的 20min 周期；失败静默，周期兜底。
        void window.nxcore.runtimeConfig?.relayReady().catch(() => undefined)
      } else {
        redeemCode.markDone('already-pro')
      }
    } catch (error) {
      if (error instanceof Error && /invitation code/i.test(error.message)) redeemCode.markInvalid()
      else redeemCode.markError()
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

  const replaceAdmissionDevice = async (replaceDeviceId: string) => {
    if (!window.nxcore || !account?.admission) return
    setPending('admission')
    try {
      setAccount(await window.nxcore.account.replaceDeviceAdmission({
        admissionToken: account.admission.admissionToken,
        replaceDeviceId,
      }))
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
    || t('surface:settings.everroomUser')
  // 第二行只放与主行不同的真实身份（姓名/手机号/邮箱），没有就不显示。
  const accountDetail = [account?.user?.name, account?.user?.phone, account?.user?.email]
    .filter((value): value is string => Boolean(value))
    .find(value => value !== accountName) ?? null

  return (
    <div className={hideHeader ? 'page settings-page is-embedded' : 'page settings-page'}>
      {hideHeader ? null : <PageHeader title={t('surface:settings.settings')} />}

      <div className="settings-layout">
        <nav className="settings-navigation" aria-label={t('surface:settings.settingsNavigation')}>
          {SETTINGS_NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className="settings-navigation-item"
              data-active={String(activeSetting === id)}
              aria-current={activeSetting === id ? 'location' : undefined}
              onClick={() => setActiveSetting(id)}
            >
              <span className="settings-navigation-icon"><Icon aria-hidden="true" /></span>
              <span>
                <strong>{t(label)}</strong>
              </span>
            </button>
          ))}
        </nav>

        <main className="settings-content" data-active-setting={activeSetting}>

      <AppearanceSettingsSection />

      <section id="settings-interface" className="reality-settings-section settings-anchor-section" aria-labelledby="interface-language-settings-title">
        <header>
          <span><Languages aria-hidden="true" /></span>
          <div>
            <h2 id="interface-language-settings-title">{t('surface:settings.interfaceLanguage')}</h2>
          </div>
        </header>
        <div className="reality-setting-row">
          <div>
            <strong>{t('surface:settings.interfaceLanguageLabel')}</strong>
          </div>
          <div className="segmented-control" aria-label={t('surface:settings.interfaceLanguageLabel')}>
            <button
              type="button"
              data-active={String(preference === 'system')}
              aria-pressed={preference === 'system'}
              onClick={() => setLocale('system')}
            >
              {t('surface:settings.followSystem')}
            </button>
            <button
              type="button"
              data-active={String(preference === 'zh-CN')}
              aria-pressed={preference === 'zh-CN'}
              onClick={() => setLocale('zh-CN')}
            >
              {t('surface:settings.simplifiedChinese')}
            </button>
            <button
              type="button"
              data-active={String(preference === 'en-US')}
              aria-pressed={preference === 'en-US'}
              onClick={() => setLocale('en-US')}
            >
              English
            </button>
          </div>
        </div>
      </section>

      <section id="settings-onboarding" className="reality-settings-section settings-anchor-section" aria-labelledby="onboarding-settings-title">
        <header>
          <span><Sparkles aria-hidden="true" /></span>
          <div>
            <h2 id="onboarding-settings-title">{t('surface:settings.onboardingSetupTitle')}</h2>
          </div>
        </header>
        <div className="reality-setting-row">
          <div>
            <strong>{t('surface:settings.fullOnboardingActionTitle')}</strong>
          </div>
          <button type="button" className="primary-button" onClick={onStartFullOnboarding} disabled={!onStartFullOnboarding}>
            <Sparkles aria-hidden="true" />{t('surface:settings.fullOnboardingAction')}
          </button>
        </div>
      </section>

      <UpdateSection />

      <ConnectorModeSection />
      <section id="settings-account" className="cloud-account-section settings-anchor-section" aria-labelledby="cloud-account-title">
        <header className="cloud-account-header">
          <span className="cloud-account-icon"><Cloud aria-hidden="true" /></span>
          <div>
            <h2 id="cloud-account-title">{t('surface:settings.everroomAccount')}</h2>
          </div>
          <div className="cloud-account-header-actions">
            {account?.authenticated ? (
              <button
                className="cloud-account-refresh"
                type="button"
                disabled={isBusy}
                aria-label={t('surface:settings.refreshAccountAndQuota')}
                title={t('surface:settings.refreshAccountAndQuota')}
                onClick={() => void refreshAccountStatus()}
              >
                <RefreshCw className={pending === 'refresh' ? 'spin' : undefined} aria-hidden="true" />
              </button>
            ) : null}
            <span className="cloud-account-state" data-connected={String(Boolean(account?.authenticated))}>
              <span aria-hidden="true" />
              {t(account === null ? 'surface:settings.checking' : account.authenticated ? 'surface:settings.connected' : 'surface:settings.signedOut')}
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
                {accountDetail ? <span>{accountDetail}</span> : null}
              </div>
              <button className="secondary-button" type="button" disabled={isBusy} onClick={logout}>
                {pending === 'logout'
                  ? <LoaderCircle className="spin" aria-hidden="true" />
                  : <LogOut aria-hidden="true" />}
                {t('surface:settings.signOut')}
              </button>
            </div>

            {account.admission ? (
              <div className="qr-login-panel qr-login-admission" role="alert">
                <div className="qr-login-admission-heading">
                  <ShieldAlert aria-hidden="true" />
                  <div>
                    <strong>{t('surface:qrLogin.deviceLimitTitle', { maxDevices: account.admission.maxDevices })}</strong>
                    <small>{t('surface:qrLogin.deviceLimitDescription')}</small>
                  </div>
                </div>
                <div className="qr-login-devices">
                  {account.admission.devices.map((device) => (
                    <button
                      key={device.id}
                      type="button"
                      className="qr-login-device"
                      disabled={isBusy}
                      onClick={() => void replaceAdmissionDevice(device.id)}
                    >
                      <Smartphone aria-hidden="true" />
                      <span>
                        <strong>{device.name}</strong>
                        <small>{device.platform}{device.appVersion ? ` · ${device.appVersion}` : ''}</small>
                      </span>
                      <em>{t('surface:qrLogin.replaceDevice')}</em>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}


            <div className="cloud-devices" aria-label={t('surface:settings.connectedDevices')}>
              <div className="cloud-devices-heading">
                <div>
                  <strong>{t('surface:settings.connectedDevices')}</strong>
                  <small>{devices.length ? t('surface:settings.countDevicesCanSyncPrivateData', { count: devices.length }) : t('surface:settings.loadingDevices')}</small>
                </div>
                <Laptop aria-hidden="true" />
              </div>
              {devices.length ? (
                <div className="cloud-device-list">
                  {devices.map((device) => {
                    const isCurrent = device.id === account.device?.id
                    const isOnline = device.connectionStatus === 'online'
                    return (
                      <div key={device.id} className="cloud-device-row">
                        <span className="cloud-device-icon" aria-hidden="true">
                          {device.platform.toLowerCase().includes('ios') ? <Smartphone /> : <Laptop />}
                        </span>
                        <div className="cloud-device-info">
                          <strong>{device.name || (device.platform.toLowerCase().includes('ios') ? 'iPhone' : 'Mac')}</strong>
                          <span>{device.platform}{device.appVersion ? ` · v${device.appVersion}` : ''}{isCurrent ? ` · ${t('surface:settings.thisDevice')}` : ''}</span>
                        </div>
                        <div className="cloud-device-status" data-online={String(isOnline)}>
                          <span aria-hidden="true" />
                          <small>{t(isOnline ? 'surface:settings.online' : 'surface:settings.offline')}</small>
                          <em>{deviceLastSeen(device.lastSeenAt, locale, t)}</em>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : <small className="cloud-device-empty">{t('surface:settings.noConnectedDevicesFound')}</small>}
            </div>
          </div>
        ) : (
          <div className="cloud-login-content">
            {!qrActive ? (
              <div className="qr-login-methods" key="cloud-methods">
                <RedeemCodeField value={redeemCode.code} state={redeemCode.state} open={redeemCode.open} disabled={isBusy} onChange={redeemCode.change} onToggle={()=>redeemCode.setOpen(value=>!value)} onVerify={()=>{void redeemCode.prepare().catch(()=>{})}}/>
                <div className="social-login-grid" aria-label={t('surface:settings.quickSignIn')}>
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
                    {t('surface:settings.signInWithApple')}
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
                    {t('surface:settings.signInWithGoogle')}
                  </button>
                  {pending === 'apple' || pending === 'google' ? (
                    <button
                      className="cloud-login-cancel"
                      type="button"
                      onClick={() => { void window.nxcore?.account.cancelOidcLogin() }}
                    >
                      {t('surface:configGate.cancelLogin')}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            <QrLoginPanel
              account={account}
              onAccountChanged={setAccount}
              onActiveChange={setQrActive}
              entryDisabled={isBusy}
            />
          </div>
        )}
      </section>

      <section id="settings-plan" className="cloud-account-section settings-anchor-section" aria-labelledby="plan-credits-title">
        <header className="cloud-account-header">
          <span className="cloud-account-icon"><WalletCards aria-hidden="true" /></span>
          <div>
            <h2 id="plan-credits-title">{t('surface:settings.navigationPlan')}</h2>
          </div>
        </header>
        {account?.authenticated ? (
          <div className="cloud-account-connected">
            {account.subscription ? (() => {
              const isProActive = account.subscription.planCode === 'pro' && ['active', 'trialing'].includes(account.subscription.status)
              const periodRemaining = aiRelayStatus?.periodRemainingCredits ?? aiRelayStatus?.remainingCredits ?? 0
              const monthlyQuota = periodRemaining + (aiRelayStatus?.usedCredits ?? 0)
              const grants = aiRelayStatus?.grants ?? []
              // 无 grants 明细(旧后端)且充值合计>0:合成一条合计兜底行,不显示"暂无"
              const grantRows = grants.length
                ? grants
                : (aiRelayStatus?.topupRemainingCredits ?? 0) > 0
                  ? [{ id: '__topup_total__', remainingCredits: aiRelayStatus?.topupRemainingCredits ?? 0, amountCredits: aiRelayStatus?.topupRemainingCredits ?? 0, expiresAt: null }]
                  : []
              const topupTotal = grants.length
                ? grants.reduce((sum, grant) => sum + grant.remainingCredits, 0)
                : (aiRelayStatus?.topupRemainingCredits ?? 0)
              const totalRemaining = aiRelayStatus?.remainingCredits ?? periodRemaining + topupTotal
              // 奖励积分 = 总剩余 - 套餐周期剩余 - 充值剩余(注册赠送等 signup_bonus grant)
              const bonusTotal = Math.max(0, totalRemaining - periodRemaining - topupTotal)
              return (
              <div className="cloud-subscription">
                <div className="plan-overview-card">
                  <div className="plan-overview-head">
                    <div className="cloud-subscription-plan">
                      <span><WalletCards aria-hidden="true" />{t('surface:settings.currentPlan')}</span>
                      <strong>{account.subscription.planName}</strong>
                      <small>{subscriptionStatusLabel(account.subscription.status, t)}</small>
                    </div>
                    {!isProActive ? (
                      <button type="button" className="topup-buy-button" onClick={() => setPlanModalOpen(true)}>
                        {t('surface:plans.buyPro')}
                      </button>
                    ) : null}
                  </div>
                  <div className="plan-overview-total">
                    <strong>{aiRelayStatus?.configured ? formatCredits(totalRemaining, locale) : '—'}</strong>
                    <span>{t('surface:settings.planOverviewTotal')}</span>
                  </div>
                  {aiRelayStatus?.configured ? (
                  <div className="plan-overview-grid">
                    <div className="plan-overview-cell">
                      <div>
                        <span>{t('surface:settings.planOverviewBuiltin')}</span>
                        <strong>{formatCredits(periodRemaining, locale)}</strong>
                      </div>
                      <progress
                        aria-label={t('surface:settings.planOverviewBuiltin')}
                        max={Math.max(1, monthlyQuota)}
                        value={Math.min(Math.max(0, periodRemaining), monthlyQuota)}
                      />
                      <small>
                        {aiRelayStatus.remainingCredits <= 0
                          ? t('surface:settings.llmQuotaExhausted')
                          : t('surface:settings.usedUsedTotalTotal', {
                            used: formatCredits(aiRelayStatus.usedCredits ?? 0, locale),
                            total: formatCredits(monthlyQuota, locale),
                          })}
                        {' · '}{t('surface:settings.periodEnds')} {formatPeriodEnd(account.subscription.periodEnd, locale)}
                      </small>
                    </div>
                    {bonusTotal > 0 ? (
                    <div className="plan-overview-cell">
                      <div>
                        <span>{t('surface:settings.planOverviewBonus')}</span>
                        <strong>{formatCredits(bonusTotal, locale)}</strong>
                      </div>
                      <small>{t('surface:settings.topupBalanceNote')}</small>
                    </div>
                    ) : null}
                    <div className="plan-overview-cell">
                      <div>
                        <span>{t('surface:settings.planOverviewPurchased')}</span>
                        <strong>{formatCredits(topupTotal, locale)}</strong>
                      </div>
                      {grantRows.length ? (
                        grantRows.map((grant) => (
                          <div key={grant.id} className="plan-overview-grant">
                            <progress
                              aria-label={t('surface:settings.topupCredits')}
                              max={Math.max(1, grant.amountCredits)}
                              value={Math.min(Math.max(0, grant.remainingCredits), Math.max(1, grant.amountCredits))}
                            />
                            <small>
                              {grant.expiresAt
                                ? t('surface:settings.topupGrantExpires', { date: formatPeriodEnd(grant.expiresAt, locale) })
                                : t('surface:settings.topupBalanceNote')}
                            </small>
                          </div>
                        ))
                      ) : (
                        <small>{t('surface:settings.planOverviewNoPurchase')}</small>
                      )}
                    </div>
                  </div>
                  ) : null}
                  {aiRelayStatus?.configured ? (
                    <button type="button" className="topup-buy-button plan-overview-topup" onClick={() => setTopupModalOpen(true)}>
                      {t('surface:settings.topupBuy')}
                    </button>
                  ) : null}
                </div>
              </div>
              )
            })() : null}

            {!(account.subscription?.planCode === 'pro' && ['active', 'trialing'].includes(account.subscription.status)) ? (
              <RedeemCodeField
                value={redeemCode.code} state={redeemCode.state} open={redeemCode.open} disabled={isBusy}
                actionLabel={t('surface:settings.redeemCodeRedeem')}
                onChange={redeemCode.change} onToggle={()=>redeemCode.setOpen(value=>!value)}
                onVerify={()=>{void redeemNow()}}
              />
            ) : null}
          </div>
        ) : (
          <small className="cloud-device-empty">{t('surface:settings.signedOut')}</small>
        )}
        <PlanUpgradeModal
          open={planModalOpen}
          onOpenChange={setPlanModalOpen}
          currentPlanCode={account?.subscription?.planCode ?? null}
          onSettled={() => { void refreshAccountStatus(); refreshAiRelay.current?.() }}
        />
        <TopupModal
          open={topupModalOpen}
          onOpenChange={setTopupModalOpen}
          onSettled={() => refreshAiRelay.current?.()}
        />
      </section>

      <section id="settings-editor" className="reality-settings-section settings-anchor-section" aria-labelledby="document-editing-settings-title">
        <header>
          <span><Sparkles aria-hidden="true" /></span>
          <div>
            <h2 id="document-editing-settings-title">{t('surface:settings.documentEditing')}</h2>
          </div>
        </header>
        <div className="reality-setting-row">
          <div>
            <strong>{t('surface:settings.smartDocumentCompletion')}</strong>
          </div>
          <button
            className="settings-toggle"
            type="button"
            role="switch"
            aria-label={t('surface:settings.smartDocumentCompletion')}
            aria-checked={cursorCompletionSettings.enabled}
            data-active={String(cursorCompletionSettings.enabled)}
            onClick={() => updateCursorCompletionSettings({
              enabled: !cursorCompletionSettings.enabled,
            })}
          >
            <span aria-hidden="true" />
            {t(cursorCompletionSettings.enabled ? 'surface:settings.on' : 'surface:settings.off')}
          </button>
        </div>
        <div className="reality-setting-row">
          <div><strong>{t('surface:settings.paragraphCompletion')}</strong></div>
          <button
            className="settings-toggle"
            type="button"
            role="switch"
            aria-label={t('surface:settings.paragraphCompletion')}
            aria-checked={cursorCompletionSettings.paragraphEnabled}
            data-active={String(cursorCompletionSettings.paragraphEnabled)}
            disabled={!cursorCompletionSettings.enabled}
            onClick={() => updateCursorCompletionSettings({
              paragraphEnabled: !cursorCompletionSettings.paragraphEnabled,
            })}
          >
            <span aria-hidden="true" />
            {t(cursorCompletionSettings.paragraphEnabled ? 'surface:settings.on' : 'surface:settings.off')}
          </button>
        </div>
        <div className="reality-setting-row">
          <div><strong>{t('surface:settings.conversationCompletion')}</strong></div>
          <button
            className="settings-toggle"
            type="button"
            role="switch"
            aria-label={t('surface:settings.conversationCompletion')}
            aria-checked={conversationSuggestionSettings.completionEnabled}
            data-active={String(conversationSuggestionSettings.completionEnabled)}
            onClick={() => updateConversationSuggestionSettings({
              completionEnabled: !conversationSuggestionSettings.completionEnabled,
            })}
          >
            <span aria-hidden="true" />
            {t(conversationSuggestionSettings.completionEnabled ? 'surface:settings.on' : 'surface:settings.off')}
          </button>
        </div>
        <div className="reality-setting-row">
          <div><strong>{t('surface:settings.starterPrompts')}</strong></div>
          <button
            className="settings-toggle"
            type="button"
            role="switch"
            aria-label={t('surface:settings.starterPrompts')}
            aria-checked={conversationSuggestionSettings.starterPromptsEnabled}
            data-active={String(conversationSuggestionSettings.starterPromptsEnabled)}
            onClick={() => updateConversationSuggestionSettings({
              starterPromptsEnabled: !conversationSuggestionSettings.starterPromptsEnabled,
            })}
          >
            <span aria-hidden="true" />
            {t(conversationSuggestionSettings.starterPromptsEnabled ? 'surface:settings.on' : 'surface:settings.off')}
          </button>
        </div>
      </section>

      <div id="settings-models" className="settings-anchor-section settings-models-group">
        <LocalAgentSettingsSection />

        <McpSettingsSection />
      </div>

      <RuntimeConfigSettingsSection />

      <div id="settings-token-usage" className="settings-anchor-section settings-token-usage-group">
        <UsageAndBudgetSettingsSection />
      </div>

        </main>
      </div>
    </div>
  )
}
