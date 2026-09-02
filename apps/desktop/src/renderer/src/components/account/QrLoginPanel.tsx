import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { useTranslation } from 'react-i18next'
import { Check, LoaderCircle, QrCode, RefreshCw, ShieldAlert, ShieldCheck, Smartphone } from 'lucide-react'

import type { CloudAccountStatus, QrLoginPresentation, QrLoginStatusPayload } from '../../../../shared/sources'
import './QrLoginPanel.css'

type RendererPhase =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'pendingScan'; presentation: QrLoginPresentation; qrDataUrl: string }
  | { kind: 'scanned'; presentation: QrLoginPresentation; qrDataUrl: string; confirmationCode: string }
  | { kind: 'confirmed'; presentation: QrLoginPresentation; qrDataUrl: string; account: { userId: string; displayName: string; identifierHint: string | null }; accountSwitch: boolean }
  | { kind: 'exchanging' }
  | { kind: 'admission'; status: CloudAccountStatus }
  | { kind: 'success' }
  | { kind: 'ended'; reason: 'rejected' | 'cancelled' | 'expired' | 'exchanged' | 'error'; message?: string }

const POLL_INTERVAL_MS = 2_000

/** 扫码登录面板：二维码展示 + 2 秒单飞轮询 + 桌面账号二次确认 + 设备准入。 */
export function QrLoginPanel(props: {
  account: CloudAccountStatus | null
  onAccountChanged: (status: CloudAccountStatus) => void
  /** 登录成功（含设备替换后）回调；gate 场景用于拉取 runtime config 并放行。 */
  onLoginSucceeded?: () => void
}) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<RendererPhase>({ kind: 'idle' })
  const inFlight = useRef(false)
  const unmounted = useRef(false)
  const lastAccountId = useRef<string | null>(props.account?.user?.id ?? null)

  useEffect(() => {
    unmounted.current = false
    return () => { unmounted.current = true }
  }, [])

  // 租约冲突时主进程推送准入挑战；面板若在登录流程中则进入设备选择阶段。
  useEffect(() => {
    if (!window.nxcore) return
    return window.nxcore.account.onAdmissionRequired((status) => {
      setPhase((current) => current.kind === 'admission' || current.kind === 'exchanging' || current.kind === 'confirmed'
        ? { kind: 'admission', status }
        : current)
    })
  }, [])

  const createSession = useCallback(async () => {
    if (!window.nxcore) return
    setPhase({ kind: 'creating' })
    try {
      const presentation = await window.nxcore.account.createQrLoginSession()
      const qrDataUrl = await QRCode.toDataURL(presentation.qrPayload, { margin: 1, width: 220, errorCorrectionLevel: 'M' })
      if (unmounted.current) return
      setPhase({ kind: 'pendingScan', presentation, qrDataUrl })
    } catch (error) {
      setPhase({ kind: 'ended', reason: 'error', message: error instanceof Error ? error.message : t('surface:qrLogin.failedToCreate') })
    }
  }, [t])

  // 单飞轮询：递归 setTimeout，禁止重叠请求；终态或卸载时停止。
  const sessionId = phase.kind === 'pendingScan' || phase.kind === 'scanned' ? phase.presentation.qrLoginSessionId : null
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    let timer = 0
    const schedule = (delay = POLL_INTERVAL_MS) => {
      if (!cancelled) timer = window.setTimeout(() => void poll(), delay)
    }
    const poll = async () => {
      if (cancelled || inFlight.current) return schedule()
      inFlight.current = true
      try {
        const next: QrLoginStatusPayload = await window.nxcore!.account.getQrLoginStatus(sessionId)
        if (cancelled) return
        if (next.status === 'pending_scan') return schedule()
        if (next.status === 'scanned') {
          setPhase((current): RendererPhase => {
            if (current.kind !== 'pendingScan' && current.kind !== 'scanned') return current
            return { kind: 'scanned', presentation: current.presentation, qrDataUrl: current.qrDataUrl, confirmationCode: next.confirmationCode }
          })
          return schedule()
        }
        if (next.status === 'confirmed') {
          setPhase((current): RendererPhase => current.kind === 'pendingScan' || current.kind === 'scanned'
            ? {
                kind: 'confirmed',
                presentation: current.presentation,
                qrDataUrl: current.qrDataUrl,
                account: next.account,
                accountSwitch: lastAccountId.current !== null && lastAccountId.current !== next.account.userId,
              }
            : current)
          return
        }
        setPhase({ kind: 'ended', reason: next.status })
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : ''
        if (message.includes('请求过于频繁')) return schedule()
        if (/QR_LOGIN_(REJECTED|CANCELLED|EXPIRED|ALREADY_EXCHANGED)/.test(message)) {
          setPhase({ kind: 'ended', reason: 'expired' })
          return
        }
        // 网络错误：退避后重试，不中断面板。
        return schedule(5_000)
      } finally {
        inFlight.current = false
      }
    }
    schedule(0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [sessionId])

  const confirmAndExchange = useCallback(async () => {
    if (!window.nxcore || phase.kind !== 'confirmed') return
    const current = phase
    setPhase({ kind: 'exchanging' })
    try {
      const status = await window.nxcore.account.exchangeQrLoginSession(current.presentation.qrLoginSessionId)
      lastAccountId.current = status.user?.id ?? null
      props.onAccountChanged(status)
      props.onLoginSucceeded?.()
      if (status.admission) {
        setPhase({ kind: 'admission', status })
        return
      }
      setPhase({ kind: 'success' })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (/QR_LOGIN_ALREADY_EXCHANGED/.test(message)) {
        setPhase({ kind: 'ended', reason: 'exchanged' })
        return
      }
      // exchange 超时可用同一桌面凭证重试（服务端 60 秒内返回相同结果）。
      setPhase({ kind: 'ended', reason: 'error', message: message || t('surface:qrLogin.failedToExchange') })
    }
  }, [phase, props, t])

  const cancel = useCallback(async () => {
    if (!window.nxcore) return
    const current = phase
    const targetSession = current.kind === 'pendingScan' || current.kind === 'scanned' || current.kind === 'confirmed'
      ? current.presentation.qrLoginSessionId
      : undefined
    try { await window.nxcore.account.cancelQrLoginSession(targetSession) } catch { /* best-effort */ }
    if (unmounted.current) return
    setPhase({ kind: 'idle' })
  }, [phase])

  const replaceDevice = useCallback(async (replaceDeviceId: string) => {
    if (!window.nxcore || phase.kind !== 'admission') return
    const admissionToken = phase.status.admission?.admissionToken
    if (!admissionToken) return
    try {
      const status = await window.nxcore.account.replaceDeviceAdmission({ admissionToken, replaceDeviceId })
      props.onAccountChanged(status)
      props.onLoginSucceeded?.()
      setPhase({ kind: 'success' })
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('surface:qrLogin.failedToReplace'))
    }
  }, [phase, props, t])

  const dismissAdmission = useCallback(async () => {
    if (!window.nxcore) return
    try { await window.nxcore.account.dismissDeviceAdmission() } catch { /* best-effort */ }
    setPhase({ kind: 'idle' })
  }, [])

  if (phase.kind === 'idle') {
    return (
      <button
        className="secondary-button qr-login-start"
        type="button"
        onClick={() => void createSession()}
      >
        <QrCode aria-hidden="true" />
        {t('surface:qrLogin.signInWithPhone')}
      </button>
    )
  }

  if (phase.kind === 'creating' || phase.kind === 'exchanging') {
    return (
      <div className="qr-login-panel qr-login-status" aria-live="polite">
        <LoaderCircle className="spin" aria-hidden="true" />
        <p>{t(phase.kind === 'creating' ? 'surface:qrLogin.creating' : 'surface:qrLogin.exchanging')}</p>
      </div>
    )
  }

  if (phase.kind === 'admission') {
    const admission = phase.status.admission
    return (
      <div className="qr-login-panel qr-login-admission" aria-live="polite">
        <div className="qr-login-admission-heading">
          <ShieldAlert aria-hidden="true" />
          <div>
            <strong>{t('surface:qrLogin.deviceLimitTitle', { maxDevices: admission?.maxDevices ?? 0 })}</strong>
            <small>{t('surface:qrLogin.deviceLimitDescription')}</small>
          </div>
        </div>
        <div className="qr-login-devices">
          {(admission?.devices ?? []).map((device) => (
            <button key={device.id} type="button" className="qr-login-device" onClick={() => void replaceDevice(device.id)}>
              <Smartphone aria-hidden="true" />
              <span>
                <strong>{device.name}</strong>
                <small>{device.platform}{device.appVersion ? ` · ${device.appVersion}` : ''}</small>
              </span>
              <em>{t('surface:qrLogin.replaceDevice')}</em>
            </button>
          ))}
        </div>
        <button type="button" className="secondary-button" onClick={() => void dismissAdmission()}>
          {t('surface:qrLogin.cancelLogin')}
        </button>
      </div>
    )
  }

  if (phase.kind === 'success') {
    return (
      <div className="qr-login-panel qr-login-status" aria-live="polite">
        <Check className="qr-login-success-icon" aria-hidden="true" />
        <strong>{t('surface:qrLogin.loginSuccess')}</strong>
      </div>
    )
  }

  if (phase.kind === 'ended') {
    return (
      <div className="qr-login-panel qr-login-status" aria-live="polite">
        <strong>{t(`surface:qrLogin.ended.${phase.reason}`)}</strong>
        {phase.message ? <small>{phase.message}</small> : null}
        <div className="qr-login-actions">
          <button type="button" className="secondary-button" onClick={() => void createSession()}>
            <RefreshCw aria-hidden="true" />
            {t('surface:qrLogin.retry')}
          </button>
          <button type="button" className="secondary-button" onClick={() => setPhase({ kind: 'idle' })}>
            {t('surface:qrLogin.close')}
          </button>
        </div>
      </div>
    )
  }

  const isPendingScan = phase.kind === 'pendingScan'
  const isScanned = phase.kind === 'scanned'
  const activePhase = phase.kind === 'pendingScan' || phase.kind === 'scanned' || phase.kind === 'confirmed'
    ? phase as Extract<RendererPhase, { kind: 'pendingScan' | 'scanned' | 'confirmed' }>
    : null
  if (!activePhase) return null
  const confirmationCode = activePhase.kind === 'scanned' ? activePhase.confirmationCode : activePhase.presentation.confirmationCode

  return (
    <div className="qr-login-panel qr-login-active" aria-live="polite">
      <div className="qr-login-qr">
        <img src={activePhase.qrDataUrl} alt={t('surface:qrLogin.qrAlt')} width={180} height={180} />
        {isPendingScan ? null : <span className="qr-login-qr-badge"><ShieldCheck aria-hidden="true" />{t('surface:qrLogin.scannedBadge')}</span>}
      </div>
      {isPendingScan ? (
        <div className="qr-login-hint">
          <strong>{t('surface:qrLogin.scanWithPhone')}</strong>
          <small>{t('surface:qrLogin.confirmationCode', { code: confirmationCode })}</small>
        </div>
      ) : isScanned ? (
        <div className="qr-login-hint">
          <strong>{t('surface:qrLogin.scannedTitle', { code: confirmationCode })}</strong>
          <small>{t('surface:qrLogin.scannedDescription')}</small>
        </div>
      ) : (
        <div className="qr-login-account">
          <span className="qr-login-avatar" aria-hidden="true">{phase.account.displayName.slice(0, 1).toUpperCase()}</span>
          <strong>{phase.account.displayName}</strong>
          {phase.account.identifierHint ? <small>{phase.account.identifierHint}</small> : null}
          {phase.accountSwitch ? (
            <p className="qr-login-switch-warning" role="alert">
              <ShieldAlert aria-hidden="true" />
              {t('surface:qrLogin.accountSwitchWarning')}
            </p>
          ) : null}
          <div className="qr-login-actions">
            <button type="button" className="primary-button" onClick={() => void confirmAndExchange()}>
              {t('surface:qrLogin.loginAsThisAccount')}
            </button>
            <button type="button" className="secondary-button" onClick={() => void cancel()}>
              {t('surface:qrLogin.cancelLogin')}
            </button>
          </div>
        </div>
      )}
      <div className="qr-login-footer">
        <span className="qr-login-countdown">{t('surface:qrLogin.refreshHint')}</span>
        <button type="button" className="link-button" onClick={() => void createSession()}>
          <RefreshCw aria-hidden="true" />
          {t('surface:qrLogin.refreshQr')}
        </button>
        <span className="qr-login-sep" aria-hidden="true">·</span>
        <button type="button" className="link-button" onClick={() => void cancel()}>
          {t('surface:qrLogin.cancelLogin')}
        </button>
      </div>
    </div>
  )
}
