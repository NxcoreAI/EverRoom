import { Info, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { onToast, type AppToastDetail } from '@/state/toast'
import { useLocale } from '@/i18n/LocaleContext'
import './AppToast.css'

export function AppToast() {
  const { t } = useLocale()
  const [toast, setToast] = useState<AppToastDetail | null>(null)

  useEffect(() => onToast(setToast), [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3_200)
    return () => window.clearTimeout(timer)
  }, [toast])

  if (!toast) return null

  return (
    <div className="app-toast" role="status" aria-live="polite">
      <span aria-hidden="true"><Info /></span>
      <div><strong>{toast.title}</strong>{toast.message ? <small>{toast.message}</small> : null}</div>
      <button type="button" aria-label={t('关闭提示')} title={t('关闭提示')} onClick={() => setToast(null)}><X aria-hidden="true" /></button>
    </div>
  )
}
