import {
  Check,
  Languages,
  RefreshCw,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import { useContextRoomState } from '@/components/context-room/ContextRoomStateProvider'
import type { ContextRoomKind, ContextRoomRecord } from '@/components/context-room/ported/types'
import {
  shouldShowRoomOnboarding,
  writeRoomOnboardingMarker,
  type RoomOnboardingMarker,
} from './roomOnboardingState'
import './RoomOnboardingGate.css'

type GateMode = 'checking' | 'app' | 'form' | 'creating' | 'success' | 'unavailable'

interface RoomOnboardingGateProps {
  children: ReactNode
  onOpenRoom: (room: { id: string; title: string; kind: ContextRoomKind }) => void
}

// Keep the guide repeatable while it is being debugged. The marker is still
// updated during a run so the form does not reopen after skip/create.
const REPEATABLE_ROOM_ONBOARDING = true

export function RoomOnboardingGate({ children, onOpenRoom }: RoomOnboardingGateProps) {
  const { locale, setLocale, t } = useLocale()
  const { state, backendReady, refreshFromBackend } = useContextRoomState()
  const markerRef = useRef<RoomOnboardingMarker | null>(null)
  const [mode, setMode] = useState<GateMode>('checking')
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [createdRoom, setCreatedRoom] = useState<ContextRoomRecord | null>(null)
  const [checkRequest, setCheckRequest] = useState(0)

  useEffect(() => {
    if (markerRef.current && !REPEATABLE_ROOM_ONBOARDING) {
      setMode('app')
      return
    }
    if (!backendReady) return
    setMode(shouldShowRoomOnboarding(backendReady, state.rooms.length, markerRef.current) ? 'form' : 'app')
  }, [backendReady, checkRequest, state.rooms.length])

  const skip = () => {
    writeRoomOnboardingMarker({ status: 'skipped' })
    markerRef.current = { status: 'skipped' }
    setMode('app')
  }

  const createRoom = async () => {
    const trimmedName = name.trim()
    const trimmedPurpose = purpose.trim()
    if (!trimmedName || !trimmedPurpose) {
      setError(t('contextRoom:onboarding.required'))
      return
    }
    setError(null)
    setMode('creating')
    try {
      const api = window.nxcore?.contextRooms
      if (!api?.create) throw new Error(t('contextRoom:roomDialogs.serviceUnavailable'))
      const result = await api.create({
        title: trimmedName.slice(0, 40),
        description: trimmedPurpose,
      })
      const refreshed = await refreshFromBackend()
      const room = refreshed?.rooms.find((item) => item.id === result.room.id)
      if (!room) throw new Error(t('contextRoom:roomDialogs.createFailed'))
      writeRoomOnboardingMarker({ status: 'completed', roomId: room.id })
      markerRef.current = { status: 'completed', roomId: room.id }
      setCreatedRoom(room)
      setMode('success')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('contextRoom:roomDialogs.createFailed'))
      setMode('form')
    }
  }

  if (mode === 'app') return <>{children}</>

  return (
    <div className="room-onboarding" data-mode={mode}>
      <header className="room-onboarding-header drag-region">
        <strong>EverRoom</strong>
        <div className="room-onboarding-actions no-drag">
          <div className="room-onboarding-language" role="group" aria-label={t('contextRoom:onboarding.language')}>
            <Languages aria-hidden="true" />
            <button type="button" data-active={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>中文</button>
            <button type="button" data-active={locale === 'en-US'} onClick={() => setLocale('en-US')}>EN</button>
          </div>
          {mode !== 'success' ? <button type="button" className="room-onboarding-skip" onClick={skip}>{t('contextRoom:onboarding.skip')}</button> : null}
        </div>
      </header>
      <main className="room-onboarding-main" aria-live="polite">
        {mode === 'checking' ? <div className="room-onboarding-status">{t('contextRoom:onboarding.checking')}</div> : null}
        {mode === 'unavailable' ? (
          <section className="room-onboarding-service">
            <span>{t('contextRoom:onboarding.eyebrow')}</span>
            <h1>{t('contextRoom:onboarding.serviceNotReady')}</h1>
            <p>{t('contextRoom:onboarding.serviceNotReadyBody')}</p>
            <div className="room-onboarding-buttons">
              <button type="button" className="room-onboarding-primary" onClick={() => { setMode('checking'); setCheckRequest((value) => value + 1) }}><RefreshCw aria-hidden="true" />{t('contextRoom:onboarding.retry')}</button>
              <button type="button" className="room-onboarding-secondary" onClick={skip}>{t('contextRoom:onboarding.skip')}</button>
            </div>
          </section>
        ) : null}
        {mode === 'form' ? (
          <section className="room-onboarding-card">
            <div className="room-onboarding-form">
              <span className="room-onboarding-eyebrow">{t('contextRoom:onboarding.eyebrow')}</span>
              <h1>{t('contextRoom:onboarding.title')}</h1>
              <p className="room-onboarding-intro">{t('contextRoom:onboarding.body')}</p>
              <label className="room-onboarding-field"><span>{t('contextRoom:onboarding.name')}</span><input autoFocus maxLength={40} value={name} placeholder={t('contextRoom:onboarding.namePlaceholder')} onChange={(event) => { setName(event.target.value); setError(null) }} /><small>{name.length}/40</small></label>
              <label className="room-onboarding-field"><span>{t('contextRoom:onboarding.purpose')}</span><textarea required maxLength={2000} value={purpose} placeholder={t('contextRoom:onboarding.purposePlaceholder')} onChange={(event) => { setPurpose(event.target.value); setError(null) }} /></label>
              <p className="room-onboarding-error" aria-live="polite">{error ?? '\u00a0'}</p>
              <button type="button" className="room-onboarding-primary room-onboarding-create" onClick={() => void createRoom()}>{t('contextRoom:onboarding.create')}</button>
            </div>
            <aside className="room-onboarding-preview">
              <div className="room-onboarding-preview-top"><span>{t('contextRoom:onboarding.memoryEnrichment')}</span><span>{t('contextRoom:onboarding.preview')}</span></div>
              <h2>{name.trim() || t('contextRoom:onboarding.previewName')}</h2>
              <p>{purpose.trim() || t('contextRoom:onboarding.previewPurpose')}</p>
              <div className="room-onboarding-rails"><span>{t('contextRoom:onboarding.documents')}</span><span>{t('contextRoom:onboarding.sources')}</span><span>{t('contextRoom:onboarding.agentActivity')}</span></div>
            </aside>
          </section>
        ) : null}
        {mode === 'creating' ? <section className="room-onboarding-service"><Check className="room-onboarding-success-icon" aria-hidden="true" /><span>{t('contextRoom:onboarding.creating')}</span><h1>{t('contextRoom:onboarding.creatingTitle')}</h1></section> : null}
        {mode === 'success' && createdRoom ? <section className="room-onboarding-service"><Check className="room-onboarding-success-icon" aria-hidden="true" /><span>{t('contextRoom:onboarding.successEyebrow')}</span><h1>{t('contextRoom:onboarding.success')}</h1><div className="room-onboarding-result"><strong>{createdRoom.title}</strong><span>{createdRoom.kind}</span></div><div className="room-onboarding-buttons"><button type="button" className="room-onboarding-primary" onClick={() => { setMode('app'); onOpenRoom({ id: createdRoom.id, title: createdRoom.title, kind: createdRoom.kind }) }}>{t('contextRoom:onboarding.open')}</button><button type="button" className="room-onboarding-secondary" onClick={() => setMode('app')}>{t('contextRoom:onboarding.continue')}</button></div></section> : null}
      </main>
    </div>
  )
}
