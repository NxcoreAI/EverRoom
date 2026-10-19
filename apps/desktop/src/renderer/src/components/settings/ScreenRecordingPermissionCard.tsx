import { useEffect, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import appIconUrl from '@/assets/everroom-app-icon.png'
import type { WindowScreenshotStatus } from '../../../../shared/sources'

type Permission = WindowScreenshotStatus['permission']
type AppInfo = { appPath: string; appName: string; iconDataUrl: string; devMode: boolean }

export function ScreenRecordingPermissionCard({ permission }: { permission: Permission | undefined }) {
  const { t } = useLocale()
  const [stage, setStage] = useState<'hidden' | 'guide' | 'restart'>('hidden')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    if (permission === undefined) return
    setStage((prev) => {
      if (permission === 'granted') return prev === 'guide' ? 'restart' : 'hidden'
      return prev === 'restart' ? 'restart' : 'guide'
    })
  }, [permission])

  useEffect(() => {
    if (stage !== 'guide') return
    let cancelled = false
    void window.nxcore?.screenCapture.appInfo()
      .then((info) => { if (!cancelled && info) setAppInfo(info) })
      .catch(() => undefined)
    const timer = setInterval(() => {
      void window.nxcore?.screenCapture.status()
        .then((status) => { if (!cancelled && status.permission === 'granted') setStage('restart') })
        .catch(() => undefined)
    }, 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [stage])

  if (stage === 'hidden') return null

  const startDrag = (event: React.DragEvent) => {
    event.preventDefault()
    window.nxcore?.screenCapture.startAppDrag()
  }

  if (stage === 'restart') {
    return (
      <div className="reality-setting-row screen-permission-row">
        <div className="screen-permission-card" data-state="granted">
          <div className="screen-permission-card-text">
            <strong>{t('surface:screenPermission.granted')}</strong>
            <span className="settings-value-text">
              {appInfo?.devMode ? t('surface:screenPermission.devRestartHint') : t('surface:screenPermission.restartHint')}
            </span>
          </div>
          {appInfo?.devMode ? null : (
            <button type="button" className="primary-button" onClick={() => void window.nxcore?.screenCapture.relaunchApp()}>
              {t('surface:screenPermission.restart')}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="reality-setting-row screen-permission-row">
      <div className="screen-permission-card" data-state="missing">
        <div className="screen-permission-card-main">
          <img
            className="screen-permission-drag-icon"
            src={appIconUrl}
            alt={appInfo?.appName ?? 'EverRoom'}
            draggable
            onDragStart={startDrag}
          />
          <div className="screen-permission-card-text">
            <strong>{t('surface:screenPermission.missingTitle')}</strong>
            <span className="settings-value-text">{t('surface:screenPermission.dragHint', { name: appInfo?.appName ?? 'EverRoom' })}</span>
          </div>
        </div>
        <button type="button" className="primary-button" onClick={() => void window.nxcore?.screenCapture.openPermissionSettings()}>
          {t('surface:screenPermission.openSettings')}
        </button>
      </div>
    </div>
  )
}
