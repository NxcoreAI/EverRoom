import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { translate, type AppLocale } from '@/i18n/LocaleContext'
import appIconUrl from '@/assets/everroom-app-icon.png'

function resolveLocale(): AppLocale {
  const stored = window.localStorage.getItem('everroom:locale:v1')
  if (stored === 'zh-CN' || stored === 'en-US') return stored
  const system = window.nxcore?.locale?.system ?? window.navigator.language
  return system.startsWith('zh') ? 'zh-CN' : 'en-US'
}

function PermissionCard() {
  const locale = resolveLocale()
  const t = (key: string, values?: Record<string, string | number>) => translate(locale, key, values)
  const [appName, setAppName] = useState('EverRoom')

  useEffect(() => {
    void window.nxcore?.screenCapture.appInfo()
      .then((info) => { if (info?.appName) setAppName(info.appName) })
      .catch(() => undefined)
  }, [])

  const startDrag = (event: React.DragEvent) => {
    event.preventDefault()
    window.nxcore?.screenCapture.startAppDrag()
  }

  return (
    <div className="card">
      <button className="close" type="button" aria-label={t('surface:screenPermission.close')} onClick={() => window.close()}>
        ×
      </button>
      <img className="icon" src={appIconUrl} alt={appName} draggable onDragStart={startDrag} />
      <div className="text">
        <strong>{t('surface:screenPermission.missingTitle')}</strong>
        <span>{t('surface:screenPermission.dragHint', { name: appName })}</span>
      </div>
    </div>
  )
}

const style = document.createElement('style')
style.textContent = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body, #root { height: 100%; background: transparent; }
  body { font-family: -apple-system, 'PingFang SC', 'Helvetica Neue', sans-serif; user-select: none; cursor: default; overflow: hidden; }
  .card {
    position: relative;
    display: flex; align-items: center; gap: 14px;
    height: 100%; padding: 16px 38px 16px 16px;
    border-radius: 12px;
    background: #ffffff;
    border: 1px solid #e1e5eb;
    box-shadow: 0 1px 2px rgba(21, 26, 34, 0.06), 0 14px 36px rgba(21, 26, 34, 0.16);
    -webkit-app-region: drag;
  }
  .icon {
    flex: none; display: block;
    width: 48px; height: 48px;
    border-radius: 11px;
    cursor: grab;
    -webkit-app-region: no-drag;
    transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 160ms;
  }
  .icon:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(21, 26, 34, 0.18); }
  .icon:active { cursor: grabbing; transform: scale(0.96); }
  .text { display: grid; gap: 5px; min-width: 0; }
  .text strong { font-size: 13px; font-weight: 600; color: #151a22; }
  .text span { font-size: 12px; line-height: 1.6; color: #536070; }
  .close {
    position: absolute; top: 7px; right: 7px;
    width: 22px; height: 22px;
    border: none; border-radius: 6px;
    background: transparent; color: #8490a0;
    font-size: 15px; line-height: 1; cursor: pointer;
    -webkit-app-region: no-drag;
  }
  .close:hover { background: #e8ecf1; color: #536070; }
`
document.head.append(style)

createRoot(document.getElementById('root')!).render(<PermissionCard />)
