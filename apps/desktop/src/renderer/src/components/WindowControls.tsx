import { Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import './WindowControls.css'

/** Windows 自绘窗口按钮：仅在 win32 桌面端渲染（macOS 使用系统红绿灯按钮）。 */
export function WindowControls() {
  const { t } = useLocale()
  const api = window.nxcore?.window
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!api || window.nxcore?.platform !== 'win32') return
    let cancelled = false
    void api.getState().then((state) => {
      if (!cancelled) setMaximized(state.maximized)
    }).catch(() => undefined)
    return api.onMaximizedChange((value) => setMaximized(value))
  }, [api])

  if (!api || window.nxcore?.platform !== 'win32') return null

  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-control"
        aria-label={t('surface:windowControls.minimize')}
        title={t('surface:windowControls.minimize')}
        onClick={() => { void api.minimize() }}
      >
        <Minus aria-hidden="true" strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={t(maximized ? 'surface:windowControls.restore' : 'surface:windowControls.maximize')}
        title={t(maximized ? 'surface:windowControls.restore' : 'surface:windowControls.maximize')}
        onClick={() => { void api.toggleMaximize() }}
      >
        {maximized ? <Copy aria-hidden="true" strokeWidth={1.8} /> : <Square aria-hidden="true" strokeWidth={1.8} />}
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        aria-label={t('surface:windowControls.close')}
        title={t('surface:windowControls.close')}
        onClick={() => { void api.close() }}
      >
        <X aria-hidden="true" strokeWidth={1.8} />
      </button>
    </div>
  )
}
