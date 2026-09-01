import { X } from 'lucide-react'
import type { FormEvent } from 'react'
import { useLocale } from '@/i18n/LocaleContext'
import { SourceIcon } from './SourceIcon'

/**
 * WebCal/ICS 日历订阅对话框（M3 webcal-url 通道的桌面入口）：
 * 用户粘贴订阅地址 → POST /v1/connectors/connections（同 URL 幂等）。
 */
export function WebcalSubscriptionDialog({
  url,
  busy,
  error,
  onUrlChange,
  onClose,
  onSubmit,
}: {
  url: string
  busy: boolean
  error: string | null
  onUrlChange: (url: string) => void
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const { t } = useLocale()
  return (
    <div className="evidence-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section className="source-connect-dialog" role="dialog" aria-modal="true" aria-labelledby="webcal-dialog-title">
        <header className="evidence-dialog-head">
          <div><span>{t('surface:webcalDialog.connectSource')}</span><h2 id="webcal-dialog-title">{t('surface:webcalDialog.calendarSubscription')}</h2><small>{t('surface:webcalDialog.hint')}</small></div>
          <button type="button" className="icon-button" title={t('surface:webcalDialog.close')} aria-label={t('surface:webcalDialog.close')} onClick={onClose}><X aria-hidden="true" strokeWidth={1.8} /></button>
        </header>
        <form className="source-connect-form" onSubmit={onSubmit}>
          <label>{t('surface:webcalDialog.subscriptionUrl')}<input required value={url} placeholder="https://example.com/calendar.ics" onChange={(event) => onUrlChange(event.target.value)} /></label>
          {error ? <p className="source-connect-error" role="alert">{error}</p> : null}
          <footer>
            <button type="button" className="secondary-button" onClick={onClose}>{t('surface:webcalDialog.cancel')}</button>
            <button type="submit" className="primary-button" disabled={busy}><SourceIcon kind="ics-calendar" />{t('surface:webcalDialog.subscribe')}</button>
          </footer>
        </form>
      </section>
    </div>
  )
}
