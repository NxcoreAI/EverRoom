import {
  BookOpen,
  BrainCircuit,
  Check,
  ChevronRight,
  DoorOpen,
  Languages,
  LoaderCircle,
  Network,
  RefreshCw,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import { useContextRoomState } from '@/components/context-room/ContextRoomStateProvider'
import { ProductBrand } from '@/components/ui/ProductBrand'
import type { ContextRoomKind, ContextRoomRecord } from '@/components/context-room/ported/types'
import { localizedRoomKind } from '@/components/context-room/ported/adapters'
import { createRoomUsageGuide } from './roomUsageGuide'
import {
  readRoomOnboardingMarker,
  shouldShowRoomOnboarding,
  writeRoomOnboardingMarker,
  type RoomOnboardingMarker,
} from './roomOnboardingState'
import './RoomOnboardingGate.css'

type GateMode = 'checking' | 'app' | 'form' | 'creating' | 'success' | 'unavailable'

interface RoomOnboardingGateProps {
  children: (controls: { openRoomOnboarding: () => void }) => ReactNode
  onOpenRoom: (room: { id: string; title: string; kind: ContextRoomKind }) => void
  suppressOnboarding?: boolean
  onFinished?: () => void
}

// The guide is shown only on first use. Its marker is still updated during a
// run so the form does not reopen after skip/create.
const REPEATABLE_ROOM_ONBOARDING = false

export function RoomOnboardingGate({ children, onOpenRoom, suppressOnboarding = false, onFinished }: RoomOnboardingGateProps) {
  const { locale, setLocale, t } = useLocale()
  const isMacDesktop = window.nxcore?.platform === 'darwin' || navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh')
  const { state, backendReady, refreshFromBackend } = useContextRoomState()
  const markerRef = useRef<RoomOnboardingMarker | null>(readRoomOnboardingMarker())
  const forceOpenRef = useRef(false)
  const initialBackendSyncRef = useRef<'idle' | 'loading' | 'done'>('idle')
  const createdRoomIdRef = useRef<string | null>(null)
  const [mode, setMode] = useState<GateMode>(() => {
    if (suppressOnboarding || markerRef.current || state.rooms.length > 0 || state.deletedRooms.length > 0) return 'app'
    return 'checking'
  })
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [createdRoom, setCreatedRoom] = useState<ContextRoomRecord | null>(null)
  const [guideCreated, setGuideCreated] = useState<boolean | null>(null)
  const [checkRequest, setCheckRequest] = useState(0)

  const openRoomOnboarding = () => {
    forceOpenRef.current = true
    setName('')
    setPurpose('')
    setError(null)
    setCreatedRoom(null)
    createdRoomIdRef.current = null
    setGuideCreated(null)
    setMode('form')
  }

  useEffect(() => {
    if (forceOpenRef.current) {
      forceOpenRef.current = false
      return
    }
    if (suppressOnboarding) {
      setMode('app')
      return
    }
    if (markerRef.current && !REPEATABLE_ROOM_ONBOARDING) {
      setMode('app')
      return
    }
    if (!backendReady) return
    // The provider starts from the local cache. On a fresh install that cache
    // is empty even when the gateway already owns Rooms, so hydrate once
    // before deciding whether this is the first-use setup.
    if (initialBackendSyncRef.current === 'loading') return
    if (initialBackendSyncRef.current === 'idle' && state.rooms.length === 0 && state.deletedRooms.length === 0) {
      initialBackendSyncRef.current = 'loading'
      setMode('checking')
      void refreshFromBackend().then((refreshed) => {
        if (!refreshed) throw new Error('Context Room backend is unavailable')
        initialBackendSyncRef.current = 'done'
        setMode(shouldShowRoomOnboarding(backendReady, refreshed.rooms.length, markerRef.current) ? 'form' : 'app')
      }).catch(() => {
        initialBackendSyncRef.current = 'idle'
        setMode('unavailable')
      })
      return
    }
    setMode(shouldShowRoomOnboarding(backendReady, state.rooms.length, markerRef.current) ? 'form' : 'app')
  }, [backendReady, checkRequest, refreshFromBackend, state.deletedRooms.length, state.rooms.length, suppressOnboarding])

  const skip = () => {
    writeRoomOnboardingMarker({ status: 'skipped' })
    markerRef.current = { status: 'skipped' }
    setMode('app')
    onFinished?.()
  }

  const finish = () => {
    setMode('app')
    onFinished?.()
  }

  const createRoom = async () => {
    const trimmedName = name.trim()
    const trimmedPurpose = purpose.trim()
    if (!trimmedName || !trimmedPurpose) {
      setError(t('contextRoom:onboarding.required'))
      return
    }
    setError(null)
    setGuideCreated(null)
    setMode('creating')
    try {
      const api = window.nxcore?.contextRooms
      if (!api?.create) throw new Error(t('contextRoom:roomDialogs.serviceUnavailable'))
      let roomId = createdRoomIdRef.current
      if (!roomId) {
        const result = await api.create({
          title: trimmedName.slice(0, 40),
          description: trimmedPurpose,
        })
        roomId = result.room.id
        createdRoomIdRef.current = roomId
      }
      const refreshed = await refreshFromBackend()
      const room = refreshed?.rooms.find((item) => item.id === roomId)
      if (!room) throw new Error(t('contextRoom:roomDialogs.createFailed'))

      let createdGuide = false
      try {
        const documents = window.nxcore?.documents
        if (documents?.import) {
          const guide = createRoomUsageGuide(room, t)
          await documents.import({
            id: guide.documentId,
            roomId: room.id,
            title: guide.title,
            contentJson: guide.contentJson,
          })
          createdGuide = true
        }
      } catch (guideError) {
        console.warn('Unable to create the Room usage guide', { roomId: room.id, guideError })
      }
      writeRoomOnboardingMarker({ status: 'completed', roomId: room.id })
      markerRef.current = { status: 'completed', roomId: room.id }
      setCreatedRoom(room)
      setGuideCreated(createdGuide)
      setMode('success')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('contextRoom:roomDialogs.createFailed'))
      setMode('form')
    }
  }

  if (mode === 'app') return <>{children({ openRoomOnboarding })}</>

  return (
    <div className="room-onboarding" data-mode={mode} data-mac-desktop={String(isMacDesktop)}>
      <header className="room-onboarding-header drag-region">
        <ProductBrand className="room-onboarding-brand" />
        <nav className="room-onboarding-sequence no-drag" aria-label={t('contextRoom:onboarding.eyebrow')}>
          <span data-state="complete"><Check aria-hidden="true" />{t('memory:onboarding.memorySetup')}</span>
          <ChevronRight aria-hidden="true" />
          <span data-state="active"><DoorOpen aria-hidden="true" />{t('contextRoom:onboarding.eyebrow')}</span>
        </nav>
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
        {mode === 'creating' ? <section className="room-onboarding-service" aria-busy="true"><LoaderCircle className="room-onboarding-loading-icon" aria-hidden="true" /><span>{t('contextRoom:onboarding.creating')}</span><h1>{t('contextRoom:onboarding.creatingTitle')}</h1><div className="room-onboarding-loading-track" aria-hidden="true"><i /><i /><i /></div></section> : null}
        {mode === 'success' && createdRoom ? (
          <section className="room-onboarding-success" aria-labelledby="room-onboarding-success-title">
            <div className="room-onboarding-success-heading">
              <div className="room-onboarding-success-icon" aria-hidden="true"><Check /></div>
              <div>
                <span>{t('contextRoom:onboarding.successEyebrow')}</span>
                <h1 id="room-onboarding-success-title">{t('contextRoom:onboarding.success')}</h1>
                <p>{t('contextRoom:onboarding.successBody')}</p>
              </div>
            </div>
            <div className="room-onboarding-success-panel">
              <div className="room-onboarding-success-room">
                <div className="room-onboarding-success-kicker"><span>{t('contextRoom:display.room')}</span><span className="room-onboarding-success-ready"><Check aria-hidden="true" />{t('contextRoom:onboarding.ready')}</span></div>
                <div className="room-onboarding-success-identity">
                  <div className="room-onboarding-success-room-icon" aria-hidden="true">{createdRoom.icon || 'R'}</div>
                  <div><h2>{createdRoom.title}</h2><p>{localizedRoomKind(createdRoom.kind, t)} · {createdRoom.roomCode}</p></div>
                </div>
                <p className="room-onboarding-success-goal">{createdRoom.brief.goal || purpose.trim()}</p>
              </div>
              <div className="room-onboarding-success-next">
                <div className="room-onboarding-success-next-heading"><span>{t('contextRoom:onboarding.next')}</span><strong>{t('contextRoom:onboarding.successNext')}</strong></div>
                <div className="room-onboarding-success-list">
                  <div className="room-onboarding-success-item"><span className="room-onboarding-success-item-icon"><BrainCircuit aria-hidden="true" /></span><span><strong>{t('contextRoom:onboarding.memoryReady')}</strong><small>{t('contextRoom:onboarding.memoryReadyBody')}</small></span><Check aria-hidden="true" /></div>
                  <div className="room-onboarding-success-item"><span className="room-onboarding-success-item-icon"><BookOpen aria-hidden="true" /></span><span><strong>{t('contextRoom:onboarding.guide')}</strong><small>{guideCreated ? t('contextRoom:onboarding.guideAdded') : t('contextRoom:onboarding.guideUnavailable')}</small></span>{guideCreated ? <Check aria-hidden="true" /> : <span className="room-onboarding-success-item-dot" aria-hidden="true" />}</div>
                  <div className="room-onboarding-success-item"><span className="room-onboarding-success-item-icon"><Network aria-hidden="true" /></span><span><strong>{t('contextRoom:onboarding.workspaceReady')}</strong><small>{t('contextRoom:onboarding.workspaceReadyBody')}</small></span><Check aria-hidden="true" /></div>
                </div>
              </div>
            </div>
            <div className="room-onboarding-success-actions"><button type="button" className="room-onboarding-primary" onClick={() => { onOpenRoom({ id: createdRoom.id, title: createdRoom.title, kind: createdRoom.kind }); finish() }}>{t('contextRoom:onboarding.open')}<ChevronRight aria-hidden="true" /></button><button type="button" className="room-onboarding-secondary" onClick={finish}>{t('contextRoom:onboarding.continue')}</button></div>
          </section>
        ) : null}
      </main>
    </div>
  )
}
