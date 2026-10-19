import { Check, Monitor } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import './ScreenRecordingPermissionOnboarding.css'

type ScreenPermissionStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
type PermissionView = 'checking' | 'waiting' | 'granted'

interface ScreenRecordingPermissionOnboardingProps {
  onNavigateStage?: (stage: 'memory' | 'room' | 'folder' | 'microphone' | 'ready') => void
  onFinished: () => void
}

export function ScreenRecordingPermissionOnboarding({ onFinished }: ScreenRecordingPermissionOnboardingProps) {
  const { t } = useLocale()
  const [view, setView] = useState<PermissionView>('checking')
  const finishedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const status = await window.nxcore?.screenCapture.status()
        if (cancelled) return
        setView(status?.permission === 'granted' ? 'granted' : 'waiting')
      } catch {
        if (!cancelled) setView('waiting')
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  const finish = () => {
    if (finishedRef.current) return
    finishedRef.current = true
    onFinished()
  }

  useEffect(() => {
    if (view !== 'granted') return
    const timer = window.setTimeout(finish, 1600)
    return () => window.clearTimeout(timer)
  }, [view])

  const statusText = view === 'granted'
    ? t('surface:onboarding.screen.granted')
    : view === 'checking'
      ? t('surface:onboarding.screen.checking')
      : t('surface:onboarding.screen.waiting')

  return (
    <section className="screen-perm" data-view={view} aria-live="polite">
      <div className="screen-perm-copy">
        <h1>{t('surface:onboarding.screen.title')}</h1>
      </div>

      <div className="screen-perm-stage">
        <button
          type="button"
          className="screen-perm-button"
          disabled={view === 'granted' || view === 'checking'}
          aria-label={t('surface:onboarding.screen.openSettings')}
          onClick={() => { void window.nxcore?.screenCapture.openPermissionSettings() }}
        >
          <span className="screen-perm-ripple" aria-hidden="true"><i /><i /><i /></span>
          <span className="screen-perm-button-face">{view === 'granted' ? <Check aria-hidden="true" /> : <Monitor aria-hidden="true" />}</span>
        </button>
        <p className="screen-perm-status" data-view={view}>
          {view === 'granted' ? null : <span className="screen-perm-status-dot" aria-hidden="true" />}
          {statusText}
        </p>
      </div>

      <div className="screen-perm-actions">
        {view === 'granted' ? (
          <button type="button" className="screen-perm-continue" onClick={finish}>
            {t('surface:onboarding.screen.continue')}
          </button>
        ) : (
          <button type="button" className="screen-perm-skip" onClick={finish}>
            {t('surface:onboarding.screen.skip')}
          </button>
        )}
      </div>
    </section>
  )
}
