import { CircleAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { DesktopRequestError } from '../../../shared/sources'
import './AppErrorDialog.css'

export function AppErrorDialog() {
  const [error, setError] = useState<DesktopRequestError | null>(null)

  useEffect(() => window.nxcore?.errors.onRequestError(setError), [])

  if (!error) return null

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
          aria-label="关闭"
          title="关闭"
          onClick={() => setError(null)}
        >
          <X aria-hidden="true" />
        </button>
        <span className="app-error-icon" aria-hidden="true"><CircleAlert /></span>
        <div className="app-error-copy">
          <h2 id="app-error-title">请求未完成</h2>
          <p id="app-error-message">{error.message}</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setError(null)}>知道了</button>
      </section>
    </div>
  )
}
