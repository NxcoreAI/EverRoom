import { CircleAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { DesktopRequestError } from '../../../shared/sources'
import { showToast } from '@/state/toast'
import { useLocale } from '@/i18n/LocaleContext'
import './AppErrorDialog.css'

export function AppErrorDialog() {
  const { t } = useLocale()
  const [error, setError] = useState<DesktopRequestError | null>(null)

  useEffect(() => window.nxcore?.errors.onRequestError((requestError) => {
    if (requestError.severity === 'notice') {
      showToast({ title: requestError.title ?? t('surface:appErrorDialog.notice'), message: requestError.message })
      return
    }
    setError(requestError)
  }), [t])

  if (!error) return null

  const handlePrimaryAction = () => {
    const action = error.action
    setError(null)
    if (action === 'open-microphone-settings') {
      void window.nxcore?.asr.openMicrophoneSettings().catch(() => undefined)
    } else if (action === 'open-system-audio-settings') {
      void window.nxcore?.asr.openSystemAudioSettings().catch(() => undefined)
    }
  }

  return (
    <div className="app-error-overlay" role="presentation" onMouseDown={() => setError(null)}>
      <section
        className="app-error-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="app-error-title"
        aria-describedby="app-error-message"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="app-error-close"
          type="button"
          aria-label={t('surface:appErrorDialog.close')}
          title={t('surface:appErrorDialog.close')}
          onClick={() => setError(null)}
        >
          <X aria-hidden="true" />
        </button>
        <span className="app-error-icon" aria-hidden="true"><CircleAlert /></span>
        <div className="app-error-copy">
          <h2 id="app-error-title">{error.title ?? t('surface:appErrorDialog.requestNotCompleted')}</h2>
          <p id="app-error-message">{error.message}</p>
        </div>
        <button className="primary-button" type="button" onClick={handlePrimaryAction}>
          {error.actionLabel ?? t('surface:appErrorDialog.gotIt')}
        </button>
      </section>
    </div>
  )
}
