import {
  Activity,
  AudioLines,
  Brain,
  Bell,
  Camera,
  CalendarClock,
  Cloud,
  ExternalLink,
  LoaderCircle,
  Languages,
  LockKeyhole,
  LogOut,
  Laptop,
  Mic,
  MonitorSpeaker,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Smartphone,
  Trash2,
  WalletCards,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

import { useAccount } from '@/state/AccountContext'
import { loadRealitySettings, saveRealitySettings, type RealitySettings } from '@/state/realitySettings'
import {
  loadDocumentCursorCompletionSettings,
  saveDocumentCursorCompletionSettings,
  type DocumentCursorCompletionSettings,
} from '@/state/documentCursorCompletionSettings'
import appleLogo from '@/assets/apple-logo.svg'
import googleLogo from '@/assets/google-logo.svg'
import type { CloudOidcProvider } from '../../../../shared/sources'
import type { AccountKeyringStatus, CloudDevice, PerceptionSettings, WindowScreenshotStatus } from '../../../../shared/sources'
import type { BrowserExtensionStatus } from '../../../../shared/browser-extension'
import type { NotificationPreferences } from '../../../../shared/notifications'
import { PageHeader } from './PageHeader'
import { McpSettingsSection } from '@/components/settings/McpSettingsSection'
import { useLocale, type AppLocale, type Translate } from '@/i18n/LocaleContext'
import { LocalModelSettingsSection } from '@/components/settings/LocalModelSettingsSection'
import { LocalAgentSettingsSection } from '@/components/settings/LocalAgentSettingsSection'
import { UsageAndBudgetSettingsSection } from '@/components/settings/UsageAndBudgetSettingsSection'
import { RuntimeConfigSettingsSection } from '@/components/settings/RuntimeConfigSettingsSection'
import { InvitationCodeField, useInvitationCode } from '@/components/account/InvitationCodeField'
import './SettingsPage.css'

const SETTINGS_NAV = [
  { id: 'settings-account', label: 'surface:settings.navigationAccount', description: 'surface:settings.navigationAccountDescription', icon: Cloud },
  { id: 'settings-notifications', label: 'surface:settings.notifications', description: 'surface:settings.notificationsDescription', icon: Bell },
  { id: 'settings-models', label: 'surface:settings.navigationModels', description: 'surface:settings.navigationModelsDescription', icon: Brain },
  { id: 'settings-runtime-config', label: 'surface:settings.navigationRuntimeConfig', description: 'surface:settings.navigationRuntimeConfigDescription', icon: ShieldCheck },
  { id: 'settings-token-usage', label: 'surface:settings.usageAndBudgets', description: 'surface:settings.usageAndBudgetsDescription', icon: Activity },
  { id: 'settings-extensions', label: 'surface:settings.extensions', description: 'surface:settings.extensionsDescription', icon: Puzzle },
  { id: 'settings-onboarding', label: 'surface:settings.onboardingSetupTitle', description: 'surface:settings.onboardingSetupDescription', icon: Sparkles },
  { id: 'settings-reality', label: 'surface:settings.realityPerception', description: 'surface:settings.navigationRealityDescription', icon: AudioLines },
  { id: 'settings-capture', label: 'surface:settings.windowScreenshots', description: 'surface:settings.navigationCaptureDescription', icon: Camera },
  { id: 'settings-editor', label: 'surface:settings.documentEditing', description: 'surface:settings.navigationEditorDescription', icon: Sparkles },
  { id: 'settings-interface', label: 'surface:settings.interfaceLanguage', description: 'surface:settings.chooseTheDisplayLanguageForEverroom', icon: Languages },
  { id: 'settings-data', label: 'surface:settings.dataManagement', description: 'surface:settings.clearAllUserDataDescription', icon: Trash2 },
]

type PendingAction = CloudOidcProvider | 'refresh' | 'logout' | 'keyring' | 'sync' | 'clear-data' | null
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

function formatSyncTime(value: string | null, locale: AppLocale, t: Translate): string {
  if (!value) return t('surface:settings.notSyncedYet')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('surface:settings.syncTimeUnknown')
  return t('surface:settings.lastSyncTime', { time: date.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) })
}

export function SettingsPage({ onStartFullOnboarding }: { onStartFullOnboarding?: () => void }) {
  const { locale, preference, setLocale, t } = useLocale()
  const { account, refreshAccount, setAccount } = useAccount()
  const [pending, setPending] = useState<PendingAction>(null)
  const [realitySettings, setRealitySettings] = useState<RealitySettings>(loadRealitySettings)
  const [cursorCompletionSettings, setCursorCompletionSettings] =
    useState<DocumentCursorCompletionSettings>(loadDocumentCursorCompletionSettings)
  const [keyring, setKeyring] = useState<AccountKeyringStatus | null>(null)
  const [syncedCount, setSyncedCount] = useState<number | null>(null)
  const [syncedAudioCount, setSyncedAudioCount] = useState<number | null>(null)
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem('everroom:last-private-sync-at')
    } catch {
      return null
    }
  })
  const [devices, setDevices] = useState<CloudDevice[]>([])
  const [pairing, setPairing] = useState<PairingSession | null>(null)
  const [pairingQr, setPairingQr] = useState<string | null>(null)
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [screenCaptureStatus, setScreenCaptureStatus] = useState<WindowScreenshotStatus | null>(null)
  const [screenCaptureInterval, setScreenCaptureInterval] = useState(5)
  const [screenCaptureBusy, setScreenCaptureBusy] = useState(false)
  const [perceptionSettings, setPerceptionSettings] = useState<PerceptionSettings | null>(null)
  const [perceptionBusy, setPerceptionBusy] = useState(false)
  const [lastScreenshotPath, setLastScreenshotPath] = useState<string | null>(null)
  const [activeSetting, setActiveSetting] = useState(SETTINGS_NAV[0].id)
  const [extensionStatus, setExtensionStatus] = useState<BrowserExtensionStatus | null>(null)
  const [extensionBusy, setExtensionBusy] = useState(false)
  const [extensionError, setExtensionError] = useState<string | null>(null)
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences | null>(null)
  const [notificationBusy, setNotificationBusy] = useState(false)
  const invitation = useInvitationCode()

  useEffect(() => {
    const api = window.nxcore?.browserExtension
    if (!api) return
    let cancelled = false
    const refresh = async () => {
      try {
        const status = await api.status()
        if (!cancelled) setExtensionStatus(status)
      } catch (error) {
        if (!cancelled) setExtensionError(error instanceof Error ? error.message : t('surface:settings.extensionUnavailable'))
      }
    }
    void refresh()
    const removeStatus = api.onStatus((status) => setExtensionStatus(status))
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      removeStatus()
    }
  }, [t])

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
    if (!account?.authenticated || !window.nxcore) {
      setNotificationPreferences(null)
      return
    }
    let cancelled = false
    void window.nxcore.notifications.preferences()
      .then((preferences) => { if (!cancelled) setNotificationPreferences(preferences) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [account?.authenticated, account?.user?.id])

  const updateNotificationPreference = (input: Partial<NotificationPreferences>) => {
    if (!window.nxcore || notificationBusy) return
    setNotificationBusy(true)
    void window.nxcore.notifications.updatePreferences(input)
      .then(setNotificationPreferences)
      .finally(() => setNotificationBusy(false))
  }

  useEffect(() => {
    const removeListener = window.nxcore?.transcriptions.onSyncCompleted(({ completedAt }) => {
      setLastSyncAt(completedAt)
      try {
        window.localStorage.setItem('everroom:last-private-sync-at', completedAt)
      } catch {
        // Storage may be unavailable in a restricted renderer context.
      }
    })
    return () => removeListener?.()
  }, [])

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

  useEffect(() => {
    if (!window.nxcore) return
    void Promise.all([
      window.nxcore.screenCapture.status(),
      window.nxcore.screenCapture.perceptionSettings(),
    ])
      .then(([status, settings]) => {
        setScreenCaptureStatus(status)
        setScreenCaptureInterval(Math.max(1, Math.round(status.intervalMs / 60_000)))
        setPerceptionSettings(settings)
      })
      .catch(() => undefined)
  }, [])

  const updateRealitySettings = (patch: Partial<RealitySettings>) => {
    setRealitySettings((current) => {
      const next = { ...current, ...patch }
      saveRealitySettings(next)
      return next
    })
  }

  const updateCursorCompletionSettings = (patch: Partial<DocumentCursorCompletionSettings>) => {
    setCursorCompletionSettings((current) => {
      const next = { ...current, ...patch }
      saveDocumentCursorCompletionSettings(next)
      return next
    })
  }

  const loginWithOidc = async (provider: CloudOidcProvider) => {
    if (!window.nxcore) return
    let invitationCode:string|undefined
    try { invitationCode=await invitation.prepare() } catch { return }
    setPending(provider)
    try {
      const nextAccount=await window.nxcore.account.loginWithOidc(provider,invitationCode)
      setAccount(nextAccount)
      if(invitationCode&&nextAccount.registration)window.alert(t(nextAccount.registration.invitationApplied?'surface:settings.invitationCodeApplied':'surface:settings.invitationCodeExistingUser'))
      try {
        window.sessionStorage.setItem('everroom:post-login-memory-check', '1')
        window.sessionStorage.setItem('everroom:post-login-room-check', '1')
      } catch {
        // Session storage is optional; mounted gates still receive the event.
      }
      window.dispatchEvent(new CustomEvent('everroom-post-login-onboarding-check'))
    } catch (error) {
      if(invitationCode&&error instanceof Error&&/invitation code/i.test(error.message))invitation.markInvalid()
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
      const syncedAt = new Date().toISOString()
      setLastSyncAt(syncedAt)
      try {
        window.localStorage.setItem('everroom:last-private-sync-at', syncedAt)
      } catch {
        // Storage may be unavailable in a restricted renderer context.
      }
    } catch {
      // The preload request interceptor reports the error globally.
    } finally {
      setPending(null)
    }
  }

  const updateScreenCapture = async (enabled: boolean) => {
    if (!window.nxcore) return
    setScreenCaptureBusy(true)
    try {
      const status = enabled
        ? await window.nxcore.screenCapture.start(screenCaptureInterval * 60_000)
        : await window.nxcore.screenCapture.stop()
      setScreenCaptureStatus(status)
    } catch {
      // The preload request interceptor reports the error globally.
    } finally {
      setScreenCaptureBusy(false)
    }
  }

  const updateOnlineVlm = async (enabled: boolean) => {
    if (!window.nxcore || !perceptionSettings) return
    setPerceptionBusy(true)
    try {
      const settings = await window.nxcore.screenCapture.updateOnlineVlm(enabled, perceptionSettings.configVersion)
      setPerceptionSettings(settings)
    } catch {
      // The preload request interceptor reports configuration and provider errors globally.
    } finally {
      setPerceptionBusy(false)
    }
  }

  const captureWindowNow = async () => {
    if (!window.nxcore) return
    setScreenCaptureBusy(true)
    try {
      const result = await window.nxcore.screenCapture.captureCurrentWindow()
      if (result.ok) setLastScreenshotPath(result.filePath)
      const status = await window.nxcore.screenCapture.status()
      setScreenCaptureStatus(status)
    } catch {
      // The preload request interceptor reports the error globally.
    } finally {
      setScreenCaptureBusy(false)
    }
  }

  const clearAllUserData = async () => {
    if (!window.nxcore || !window.confirm(t('surface:settings.clearAllUserDataConfirm'))) return
    setPending('clear-data')
    try {
      await window.nxcore.app.clearUserData()
    } catch {
      setPending(null)
    }
  }

  const isBusy = pending !== null
  const accountName = account?.user?.email
    || account?.user?.name
    || account?.user?.phone
    || t('surface:settings.everroomUser')

  const installExtension = async () => {
    const api = window.nxcore?.browserExtension
    if (!api) return
    setExtensionBusy(true)
    setExtensionError(null)
    try {
      setExtensionStatus(await api.install())
    } catch (error) {
      setExtensionError(error instanceof Error ? error.message : t('surface:settings.extensionInstallFailed'))
    } finally {
      setExtensionBusy(false)
    }
  }

  const createExtensionPairing = async () => {
    const api = window.nxcore?.browserExtension
    if (!api) return
    setExtensionBusy(true)
    setExtensionError(null)
    try {
      setExtensionStatus(await api.createPairing())
    } catch (error) {
      setExtensionError(error instanceof Error ? error.message : t('surface:settings.extensionPairingFailed'))
    } finally {
      setExtensionBusy(false)
    }
  }

  const revokeExtension = async () => {
    const api = window.nxcore?.browserExtension
    if (!api) return
    setExtensionBusy(true)
    setExtensionError(null)
    try {
      setExtensionStatus(await api.revoke())
    } catch (error) {
      setExtensionError(error instanceof Error ? error.message : t('surface:settings.extensionRevokeFailed'))
    } finally {
      setExtensionBusy(false)
    }
  }

  const openExtensionDirectory = async () => {
    try {
      await window.nxcore?.browserExtension.openDirectory()
    } catch (error) {
      setExtensionError(error instanceof Error ? error.message : t('surface:settings.extensionDirectoryFailed'))
    }
  }

  const openBrowserExtensionsPage = async () => {
    try {
      await window.nxcore?.browserExtension.openBrowserPage()
    } catch (error) {
      setExtensionError(error instanceof Error ? error.message : t('surface:settings.extensionBrowserPageFailed'))
    }
  }

  return (
    <div className="page settings-page">
      <PageHeader title={t('surface:settings.settings')} />

      <div className="settings-layout">
        <nav className="settings-navigation" aria-label={t('surface:settings.settingsNavigation')}>
          {SETTINGS_NAV.map(({ id, label, description, icon: Icon }) => (
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
                <small>{t(description)}</small>
              </span>
            </button>
          ))}
        </nav>

        <main className="settings-content" data-active-setting={activeSetting}>

      <section id="settings-interface" className="reality-settings-section settings-anchor-section" aria-labelledby="interface-language-settings-title">
        <header>
          <span><Languages aria-hidden="true" /></span>
          <div>
            <h2 id="interface-language-settings-title">{t('surface:settings.interfaceLanguage')}</h2>
            <p>{t('surface:settings.chooseTheDisplayLanguageForEverroom')}</p>
          </div>
        </header>
        <div className="reality-setting-row">
          <div>
            <strong>{t('surface:settings.interfaceLanguageLabel')}</strong>
            <small>{t('surface:settings.changesApplyImmediatelyAndAreSavedOnThis')}</small>
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

      <section id="settings-data" className="reality-settings-section settings-anchor-section" aria-labelledby="data-management-settings-title">
        <header>
          <span><Trash2 aria-hidden="true" /></span>
          <div>
            <h2 id="data-management-settings-title">{t('surface:settings.dataManagement')}</h2>
            <p>{t('surface:settings.clearAllUserDataDescription')}</p>
          </div>
        </header>
        <div className="reality-setting-row">
          <div>
            <strong>{t('surface:settings.clearAllUserData')}</strong>
            <small>{t('surface:settings.clearAllUserDataBody')}</small>
          </div>
          <button type="button" className="danger-button" disabled={isBusy || !window.nxcore} onClick={() => void clearAllUserData()}>
            {pending === 'clear-data' ? <LoaderCircle className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
            {t('surface:settings.clearAllUserData')}
          </button>
        </div>
      </section>

      <section id="settings-onboarding" className="reality-settings-section settings-anchor-section" aria-labelledby="onboarding-settings-title">
        <header>
          <span><Sparkles aria-hidden="true" /></span>
          <div>
            <h2 id="onboarding-settings-title">{t('surface:settings.onboardingSetupTitle')}</h2>
            <p>{t('surface:settings.onboardingSetupBody')}</p>
          </div>
        </header>
        <div className="reality-setting-row">
          <div>
            <strong>{t('surface:settings.fullOnboardingActionTitle')}</strong>
            <small>{t('surface:settings.fullOnboardingActionBody')}</small>
          </div>
          <button type="button" className="primary-button" onClick={onStartFullOnboarding} disabled={!onStartFullOnboarding}>
            <Sparkles aria-hidden="true" />{t('surface:settings.fullOnboardingAction')}
          </button>
        </div>
      </section>

      <section id="settings-extensions" className="reality-settings-section settings-anchor-section browser-extension-settings" aria-labelledby="browser-extension-settings-title">
        <header>
          <span><Puzzle aria-hidden="true" /></span>
          <div>
            <h2 id="browser-extension-settings-title">{t('surface:settings.extensions')}</h2>
            <p>{t('surface:settings.extensionsBody')}</p>
          </div>
        </header>
        <div className="browser-extension-status-row">
          <div className="browser-extension-status-indicator" data-state={extensionStatus?.state ?? 'unavailable'} aria-hidden="true" />
          <div>
            <strong>{t(extensionStatus?.state === 'paired'
              ? 'surface:settings.extensionPaired'
              : extensionStatus?.state === 'waiting-for-extension'
                ? 'surface:settings.extensionWaiting'
                  : 'surface:settings.extensionNotConnected')}</strong>
            <small>{extensionStatus?.pairedExtensionId
              ? t('surface:settings.extensionId', { id: extensionStatus.pairedExtensionId })
              : t('surface:settings.extensionLocalOnly')}</small>
          </div>
        </div>
        {extensionStatus?.pairing ? (
          <div className="browser-extension-pairing-panel" aria-live="polite">
            <div>
              <strong>{t(extensionStatus.state === 'paired'
                ? 'surface:settings.extensionPaired'
                : 'surface:settings.extensionPairingInProgress')}</strong>
              <small>{t('surface:settings.extensionPairingExpires', { time: new Date(extensionStatus.pairing.expiresAt).toLocaleTimeString(locale) })}</small>
            </div>
            {extensionStatus.pairing.extensionId ? <code>{extensionStatus.pairing.extensionId}</code> : null}
          </div>
        ) : null}
        <div className="browser-extension-actions">
          {extensionStatus?.state === 'paired' ? (
            <button type="button" className="danger-button" disabled={extensionBusy} onClick={() => void revokeExtension()}>
              {extensionBusy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Puzzle aria-hidden="true" />}
              {t('surface:settings.revokeExtension')}
            </button>
          ) : (
            <>
              <button type="button" className="primary-button" disabled={extensionBusy} onClick={() => void installExtension()}>
                {extensionBusy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Puzzle aria-hidden="true" />}
                {t(extensionStatus?.mode === 'development'
                  ? 'surface:settings.loadDevelopmentExtension'
                  : 'surface:settings.installExtension')}
              </button>
              <button type="button" className="secondary-button" disabled={extensionBusy} onClick={() => void createExtensionPairing()}>
                {extensionBusy ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                {t('surface:settings.connectExtension')}
              </button>
            </>
          )}
          {extensionStatus?.mode === 'development' ? (
            <>
              <button type="button" className="secondary-button" disabled={extensionBusy} onClick={() => void openExtensionDirectory()}>
                <Puzzle aria-hidden="true" />{t('surface:settings.openExtensionDirectory')}
              </button>
              <button type="button" className="secondary-button" disabled={extensionBusy} onClick={() => void openBrowserExtensionsPage()}>
                <ExternalLink aria-hidden="true" />{t('surface:settings.openBrowserExtensionsPage')}
              </button>
            </>
          ) : null}
        </div>
        <p className="browser-extension-note">{t(extensionStatus?.mode === 'development'
          ? 'surface:settings.extensionsDevelopmentNote'
          : 'surface:settings.extensionsInstallNote')}</p>
        {extensionError ? <p className="browser-extension-error" role="alert">{extensionError}</p> : null}
        {extensionStatus?.lastMessage ? (
          <div className="browser-extension-last-message">
            <span>{t('surface:settings.extensionLastMessage')}</span>
            <code>{extensionStatus.lastMessage.type}</code>
          </div>
        ) : null}
      </section>

      <section id="settings-account" className="cloud-account-section settings-anchor-section" aria-labelledby="cloud-account-title">
        <header className="cloud-account-header">
          <span className="cloud-account-icon"><Cloud aria-hidden="true" /></span>
          <div>
            <h2 id="cloud-account-title">{t('surface:settings.everroomAccount')}</h2>
            <p>{t(account?.authenticated ? 'surface:settings.cloudServicesConnected' : 'surface:settings.signInToUseSubscriptionQuotaAndHosted')}</p>
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
                <span>{account.user?.name && account.user.name !== accountName
                  ? account.user.name
                  : account.user?.phone || t('surface:settings.verifiedByLogto')}</span>
                <small>{account.apiBaseUrl}</small>
              </div>
              <button className="secondary-button" type="button" disabled={isBusy} onClick={logout}>
                {pending === 'logout'
                  ? <LoaderCircle className="spin" aria-hidden="true" />
                  : <LogOut aria-hidden="true" />}
                {t('surface:settings.signOut')}
              </button>
            </div>

            {account.subscription ? (
              <div className="cloud-subscription">
                <div className="cloud-subscription-plan">
                  <span><WalletCards aria-hidden="true" />{t('surface:settings.currentPlan')}</span>
                  <strong>{account.subscription.planName}</strong>
                  <small>{subscriptionStatusLabel(account.subscription.status, t)}</small>
                </div>
                <div className="cloud-subscription-quota">
                  <div>
                    <span>{t('surface:settings.transcriptionRemaining')}</span>
                    <strong>{formatMinutes(account.subscription.remainingSeconds, locale, t, 'up')}</strong>
                  </div>
                  <progress
                    aria-label={t('surface:settings.transcriptionRemainingThisPeriod')}
                    max={Math.max(1, account.subscription.quotaSeconds)}
                    value={Math.min(
                      Math.max(0, account.subscription.remainingSeconds),
                      account.subscription.quotaSeconds,
                    )}
                  />
                  <small>
                    {t('surface:settings.usedUsedTotalTotal', {
                      used: formatMinutes(account.subscription.usedSeconds, locale, t),
                      total: formatMinutes(account.subscription.quotaSeconds, locale, t),
                    })}
                  </small>
                </div>
                <div className="cloud-subscription-period">
                  <span><CalendarClock aria-hidden="true" />{t('surface:settings.periodEnds')}</span>
                  <strong>{formatPeriodEnd(account.subscription.periodEnd, locale)}</strong>
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
                    const isOnline = device.status === 'online'
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

            <div className="cloud-keyring" aria-label={t('surface:settings.cloudSync')}>
              <div className="cloud-keyring-main">
                <div className="cloud-keyring-heading">
                  <span><ShieldCheck aria-hidden="true" /></span>
                  <div>
                    <strong>{t('surface:settings.cloudSync')}</strong>
                    <small>{t('surface:settings.syncRecordingsTranscriptsAndSummariesAcrossSignedIn')}</small>
                  </div>
                </div>
                {syncedCount !== null ? <small className="cloud-keyring-result">{t('surface:settings.syncedCountTranscriptsAndFoundAudiocountAudioClips', { count: syncedCount, audioCount: syncedAudioCount ?? 0 })}</small> : null}
              </div>
              <div className="cloud-keyring-actions">
                <button
                  className="secondary-button cloud-keyring-sync"
                  type="button"
                  disabled={isBusy}
                  onClick={() => void syncPrivate()}
                >
                  {pending === 'sync' ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                  {t('surface:settings.syncDeviceData')}
                </button>
                <small className="cloud-keyring-last-sync">{formatSyncTime(lastSyncAt, locale, t)}</small>
              </div>
            </div>
          </div>
        ) : (
          <div className="cloud-login-content">
            <InvitationCodeField value={invitation.code} state={invitation.state} open={invitation.open} disabled={isBusy} onChange={invitation.change} onToggle={()=>invitation.setOpen(value=>!value)}/>
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
            </div>

            <p className="oidc-login-note">
              <LockKeyhole aria-hidden="true" />
              {pending === 'apple' || pending === 'google'
                ? t('surface:settings.completeSignInInYourBrowserYouWill')
                : t('surface:settings.signInIsCompletedSecurelyInYourBrowser')}
            </p>

          </div>
        )}
      </section>

      {account?.authenticated && notificationPreferences ? (
        <section id="settings-notifications" className="reality-settings-section settings-anchor-section" aria-labelledby="notification-settings-title">
          <header>
            <span><Bell aria-hidden="true" /></span>
            <div>
              <h2 id="notification-settings-title">{t('surface:settings.notifications')}</h2>
              <p>{t('surface:settings.notificationsDescription')}</p>
            </div>
          </header>
          {([
            ['enabled', 'surface:settings.notificationsAll', false],
            ['iosEnabled', 'surface:settings.notificationsIos', !notificationPreferences.enabled],
            ['macosEnabled', 'surface:settings.notificationsMacos', !notificationPreferences.enabled],
          ] as const).map(([key, label, parentDisabled]) => (
            <div className="reality-setting-row" key={key}>
              <div><strong>{t(label)}</strong></div>
              <button
                type="button"
                className="settings-toggle"
                role="switch"
                aria-checked={notificationPreferences[key]}
                data-active={String(notificationPreferences[key])}
                disabled={notificationBusy || parentDisabled}
                onClick={() => updateNotificationPreference({ [key]: !notificationPreferences[key] })}
              >
                <span aria-hidden="true" />
                {t(notificationPreferences[key] ? 'surface:settings.notificationsOn' : 'surface:settings.notificationsOff')}
              </button>
            </div>
          ))}
        </section>
      ) : null}

      <section id="settings-editor" className="reality-settings-section settings-anchor-section" aria-labelledby="document-editing-settings-title">
        <header>
          <span><Sparkles aria-hidden="true" /></span>
          <div>
            <h2 id="document-editing-settings-title">{t('surface:settings.documentEditing')}</h2>
            <p>{t('surface:settings.manageEditorAssistanceFeatures')}</p>
          </div>
        </header>
        <div className="reality-setting-row">
          <div>
            <strong>{t('surface:settings.smartDocumentCompletion')}</strong>
            <small>{t('surface:settings.suggestContinuationsAfterTypingDeletingOrMovingThe')}</small>
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
          <div>
            <strong>{t('surface:settings.paragraphCompletion')}</strong>
            <small>{t('surface:settings.paragraphCompletionDescription')}</small>
          </div>
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
      </section>

      <div id="settings-models" className="settings-anchor-section settings-models-group">
        <LocalModelSettingsSection />

        <LocalAgentSettingsSection />

        <McpSettingsSection />
      </div>

      <RuntimeConfigSettingsSection />

      <div id="settings-token-usage" className="settings-anchor-section settings-token-usage-group">
        <UsageAndBudgetSettingsSection />
      </div>

      <section id="settings-reality" className="reality-settings-section settings-anchor-section" aria-labelledby="reality-settings-title">
        <header>
          <span><AudioLines aria-hidden="true" /></span>
          <div>
            <h2 id="reality-settings-title">{t('surface:settings.realityPerception')}</h2>
            <p>{t('surface:settings.configureAudioSourcesAndTranscriptionForListening')}</p>
          </div>
        </header>
        <div className="reality-setting-row">
          <div><strong>{t('surface:settings.transcriptionService')}</strong><small>{t('surface:settings.autoModePrefersSaasAfterSignIn')}</small></div>
          <div className="segmented-control" aria-label={t('surface:settings.realityPerceptionTranscriptionService')}>
            {([['auto', 'surface:settings.automatic'], ['cloud', 'surface:settings.saas'], ['local', 'surface:settings.local']] as const).map(([value, label]) => (
              <button key={value} type="button" data-active={String(realitySettings.mode === value)} disabled={value === 'cloud' && !account?.authenticated} onClick={() => updateRealitySettings({ mode: value })}>{t(label)}</button>
            ))}
          </div>
        </div>
        <div className="reality-setting-row">
          <div><strong>{t('surface:settings.recordingSource')}</strong><small>{t('surface:settings.computerAudioRequiresMacosSystemPermission')}</small></div>
          <div className="segmented-control reality-source-setting" aria-label={t('surface:settings.realityPerceptionRecordingSource')}>
            <button type="button" data-active={String(realitySettings.audioSource === 'microphone')} onClick={() => updateRealitySettings({ audioSource: 'microphone' })}><Mic aria-hidden="true" />{t('surface:settings.microphone')}</button>
            <button type="button" data-active={String(realitySettings.audioSource === 'system')} disabled={window.nxcore?.platform !== 'darwin'} onClick={() => updateRealitySettings({ audioSource: 'system' })}><MonitorSpeaker aria-hidden="true" />{t('surface:settings.computerAudio')}</button>
          </div>
        </div>
        <div className="reality-setting-row">
          <div><strong>{t('surface:settings.transcriptionLanguages')}</strong><small>{t('surface:settings.keepAtLeastOnePrimaryLanguage')}</small></div>
          <div className="segmented-control" aria-label={t('surface:settings.realityPerceptionTranscriptionLanguages')}>
            {([['zh', 'surface:settings.chinese'], ['en', 'surface:settings.english']] as const).map(([value, label]) => {
              const active = realitySettings.languages.includes(value)
              return <button key={value} type="button" data-active={String(active)} onClick={() => updateRealitySettings({ languages: active && realitySettings.languages.length > 1 ? realitySettings.languages.filter((item) => item !== value) : active ? realitySettings.languages : [...realitySettings.languages, value] })}>{t(label)}</button>
            })}
          </div>
        </div>
      </section>

      <section id="settings-capture" className="reality-settings-section settings-anchor-section" aria-labelledby="screen-capture-settings-title">
        <header>
          <span><Camera aria-hidden="true" /></span>
          <div>
            <h2 id="screen-capture-settings-title">{t('surface:settings.windowScreenshots')}</h2>
            <p>{t('surface:settings.onlyTheCurrentEverroomWindowIsSavedOther')}</p>
          </div>
        </header>
        <div className="reality-setting-row">
          <div><strong>{t('surface:settings.automaticScreenshots')}</strong><small>{t('surface:settings.screenshotsAreSavedInTheProjectScreenshotsFolder')}</small></div>
          <button
            className="settings-toggle"
            type="button"
            role="switch"
            aria-checked={Boolean(screenCaptureStatus?.enabled)}
            disabled={screenCaptureBusy || screenCaptureStatus === null}
            data-active={String(Boolean(screenCaptureStatus?.enabled))}
            onClick={() => void updateScreenCapture(!screenCaptureStatus?.enabled)}
          >
            <span aria-hidden="true" />
            {t(screenCaptureStatus?.enabled ? 'surface:settings.on' : 'surface:settings.off')}
          </button>
        </div>
        <div className="reality-setting-row">
          <div><strong>{t('surface:settings.visualUnderstanding')}</strong><small>{t('surface:settings.visualUnderstandingDescription')}</small></div>
          <button
            className="settings-toggle"
            type="button"
            role="switch"
            aria-label={t('surface:settings.visualUnderstanding')}
            aria-checked={Boolean(perceptionSettings?.onlineVlmEnabled)}
            disabled={perceptionBusy || perceptionSettings === null}
            data-active={String(Boolean(perceptionSettings?.onlineVlmEnabled))}
            onClick={() => void updateOnlineVlm(!perceptionSettings?.onlineVlmEnabled)}
          >
            <span aria-hidden="true" />
            {t(perceptionSettings?.onlineVlmEnabled ? 'surface:settings.on' : 'surface:settings.off')}
          </button>
        </div>
        <div className="reality-setting-row">
          <div><strong>{t('surface:settings.screenshotInterval')}</strong><small>{t('surface:settings.theMinimumAutomaticScreenshotIntervalIs30Seconds')}</small></div>
          <select
            value={screenCaptureInterval}
            disabled={screenCaptureBusy || screenCaptureStatus === null}
            onChange={(event) => {
              const minutes = Number(event.target.value)
              setScreenCaptureInterval(minutes)
              if (window.nxcore) {
                void window.nxcore.screenCapture.updateInterval(minutes * 60_000)
                  .then(setScreenCaptureStatus)
                  .catch(() => undefined)
              }
            }}
          >
            {[1, 5, 10, 15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>{t('surface:settings.minutesMinutes', { minutes })}</option>)}
          </select>
        </div>
        <div className="reality-setting-row">
          <div><strong>{t('surface:settings.captureNow')}</strong><small>{lastScreenshotPath || t('surface:settings.useThisToConfirmTheCurrentWindowIs')}</small></div>
          <button className="secondary-button" type="button" disabled={screenCaptureBusy} onClick={() => void captureWindowNow()}>
            {screenCaptureBusy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Camera aria-hidden="true" />}
            {t('surface:settings.captureCurrentWindow')}
          </button>
        </div>
      </section>

        </main>
      </div>
    </div>
  )
}
