import { CircleAlert, Info, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { onToast, type AppToastDetail } from '@/state/toast'
import { useLocale } from '@/i18n/LocaleContext'
import './AppToast.css'

interface ActiveToast extends AppToastDetail {
  key: number
}

const TOAST_OUT_MS = 240

function toastDurationMs(toast: AppToastDetail): number {
  if (toast.variant === 'error') return toast.actionLabel ? 8_000 : 4_500
  return 3_200
}

export function AppToast() {
  const { t } = useLocale()
  const [toast, setToast] = useState<ActiveToast | null>(null)
  const [leaving, setLeaving] = useState(false)
  const leavingTimerRef = useRef<number | null>(null)

  useEffect(() => onToast((detail) => {
    setToast({ ...detail, key: Date.now() })
    setLeaving(false)
  }), [])

  useEffect(() => {
    if (!toast || leaving) return
    const timer = window.setTimeout(() => setLeaving(true), toastDurationMs(toast))
    return () => window.clearTimeout(timer)
  }, [toast, leaving])

  const finishLeave = useCallback(() => {
    setLeaving(false)
    setToast(null)
  }, [])

  // prefers-reduced-motion 时退场动画不触发 animationend，定时兜底卸载。
  useEffect(() => {
    if (!leaving) return
    leavingTimerRef.current = window.setTimeout(finishLeave, TOAST_OUT_MS + 60)
    return () => {
      if (leavingTimerRef.current !== null) window.clearTimeout(leavingTimerRef.current)
    }
  }, [leaving, finishLeave])

  if (!toast) return null
  const isError = toast.variant === 'error'

  return (
    <div
      key={toast.key}
      className="app-toast"
      data-variant={toast.variant ?? 'info'}
      data-leaving={leaving ? 'true' : undefined}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      onAnimationEnd={(event) => {
        if (leaving && event.animationName.endsWith('-out')) finishLeave()
      }}
    >
      <span aria-hidden="true">{isError ? <CircleAlert /> : <Info />}</span>
      <div>
        <strong>{toast.title}</strong>
        {toast.message ? <small>{toast.message}</small> : null}
        {toast.actionLabel ? (
          <button
            type="button"
            className="app-toast-action"
            onClick={() => {
              toast.onAction?.()
              setLeaving(true)
            }}
          >
            {toast.actionLabel}
          </button>
        ) : null}
      </div>
      <button type="button" aria-label={t('surface:appToast.dismissNotification')} title={t('surface:appToast.dismissNotification')} onClick={() => setLeaving(true)}><X aria-hidden="true" /></button>
    </div>
  )
}
