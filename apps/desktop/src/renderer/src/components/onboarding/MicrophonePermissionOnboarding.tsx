import { Check, Mic, MicOff, Settings } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import './MicrophonePermissionOnboarding.css'

type MicrophonePermissionStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
type PermissionView = 'checking' | 'undetermined' | 'requesting' | 'granted' | 'denied'

interface MicrophonePermissionOnboardingProps {
  onNavigateStage?: (stage: 'memory' | 'room' | 'folder' | 'ready') => void
  onFinished: () => void
}

export function MicrophonePermissionOnboarding({ onNavigateStage, onFinished }: MicrophonePermissionOnboardingProps) {
  const { t } = useLocale()
  const [view, setView] = useState<PermissionView>('checking')
  const [busy, setBusy] = useState(false)
  const finishedRef = useRef(false)
  const statusRequestRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const requestId = ++statusRequestRef.current
      try {
        const status = await window.nxcore?.asr?.getMicrophoneAccessStatus()
        if (cancelled || requestId !== statusRequestRef.current) return
        setView(status === 'granted' ? 'granted' : status === 'denied' || status === 'restricted' ? 'denied' : status === 'not-determined' ? 'undetermined' : 'checking')
      } catch {
        if (cancelled || requestId !== statusRequestRef.current) return
        setView('undetermined')
      }
    }
    void refresh()
    const onWindowFocus = () => { void refresh() }
    window.addEventListener('focus', onWindowFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onWindowFocus)
    }
  }, [])

  const request = async () => {
    if (busy) return
    setBusy(true)
    setView('requesting')
    try {
      const allowed = await window.nxcore?.asr?.requestMicrophoneAccess()
      setView(allowed ? 'granted' : 'denied')
    } catch {
      setView('denied')
    } finally {
      setBusy(false)
    }
  }

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
    ? t('surface:onboarding.microphone.granted')
    : view === 'requesting'
      ? t('surface:onboarding.microphone.requesting')
      : view === 'denied'
        ? t('surface:onboarding.microphone.deniedHint')
        : view === 'checking'
          ? t('surface:onboarding.microphone.checking')
          : t('surface:onboarding.microphone.idleHint')

  return (
    <section className="mic-perm" data-view={view} aria-live="polite">
      <div className="mic-perm-copy">
        <h1>{t('surface:onboarding.microphone.title')}</h1>
        <p>{t('surface:onboarding.microphone.body')}</p>
      </div>

      <div className="mic-perm-stage">
        <button
          type="button"
          className="mic-perm-button"
          disabled={view === 'granted' || view === 'requesting' || view === 'checking'}
          aria-label={view === 'granted' ? t('surface:onboarding.microphone.granted') : t('surface:onboarding.microphone.authorize')}
          onClick={() => {
            if (view === 'denied') { void window.nxcore?.asr?.openMicrophoneSettings(); return }
            void request()
          }}
        >
          <span className="mic-perm-ripple" aria-hidden="true"><i /><i /><i /></span>
          <span className="mic-perm-button-face">{view === 'granted' ? <Check aria-hidden="true" /> : view === 'denied' ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}</span>
        </button>
        <p className="mic-perm-status" data-view={view}>
          {view === 'requesting' ? <span className="mic-perm-status-dot" aria-hidden="true" /> : null}
          {statusText}
        </p>
        {view === 'denied' ? (
          <button type="button" className="mic-perm-settings" onClick={() => { void window.nxcore?.asr?.openMicrophoneSettings() }}>
            <Settings aria-hidden="true" />{t('surface:onboarding.microphone.openSettings')}
          </button>
        ) : null}
      </div>

      <div className="mic-perm-actions">
        {view === 'granted' ? (
          <button type="button" className="mic-perm-continue" onClick={finish}>
            {t('surface:onboarding.microphone.continue')}
          </button>
        ) : (
          <button type="button" className="mic-perm-skip" onClick={finish}>
            {t('surface:onboarding.microphone.skip')}
          </button>
        )}
      </div>
    </section>
  )
}
