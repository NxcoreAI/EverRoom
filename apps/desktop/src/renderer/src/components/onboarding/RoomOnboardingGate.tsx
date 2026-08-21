import {
  ArrowRight,
  BookOpen,
  BrainCircuit,
  Check,
  ChevronRight,
  DoorOpen,
  FolderOpen,
  FolderPlus,
  Languages,
  LoaderCircle,
  Network,
  RefreshCw,
  ShieldCheck,
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

type GateMode = 'checking' | 'app' | 'form' | 'creating' | 'success' | 'setup' | 'setup-saving' | 'unavailable'

interface RoomOnboardingGateProps {
  children: (controls: { openRoomOnboarding: () => void }) => ReactNode
  onOpenRoom: (room: { id: string; title: string; kind: ContextRoomKind }) => void
  suppressOnboarding?: boolean
}

// The guide is shown only on first use. Its marker is still updated during a
// run so the form does not reopen after skip/create.
const REPEATABLE_ROOM_ONBOARDING = false

export function RoomOnboardingGate({ children, onOpenRoom, suppressOnboarding = false }: RoomOnboardingGateProps) {
  const { locale, setLocale, t } = useLocale()
  const isMacDesktop = window.nxcore?.platform === 'darwin' || navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh')
  const { state, backendReady, refreshFromBackend } = useContextRoomState()
  const markerRef = useRef<RoomOnboardingMarker | null>(readRoomOnboardingMarker())
  const forceOpenRef = useRef(false)
  const initialBackendSyncRef = useRef<'idle' | 'loading' | 'done'>('idle')
  const createdRoomIdRef = useRef<string | null>(null)
  const [mode, setMode] = useState<GateMode>('checking')
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [createdRoom, setCreatedRoom] = useState<ContextRoomRecord | null>(null)
  const [guideCreated, setGuideCreated] = useState<boolean | null>(null)
  const [selectedFolders, setSelectedFolders] = useState<Array<'documents' | 'desktop'>>(['documents', 'desktop'])
  const [customFolders, setCustomFolders] = useState<string[]>([])
  const [setupError, setSetupError] = useState<string | null>(null)
  const [checkRequest, setCheckRequest] = useState(0)

  const openRoomOnboarding = () => {
    forceOpenRef.current = true
    setName('')
    setPurpose('')
    setError(null)
    setCreatedRoom(null)
    createdRoomIdRef.current = null
    setGuideCreated(null)
    setSelectedFolders(['documents', 'desktop'])
    setCustomFolders([])
    setSetupError(null)
    setMode('form')
  }

  useEffect(() => {
    if (suppressOnboarding) {
      setMode('app')
      return
    }
    if (forceOpenRef.current) {
      forceOpenRef.current = false
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

  const openFolderSetup = () => {
    setSetupError(null)
    setMode('setup')
  }

  const skipFolderSetup = () => {
    setMode('app')
    if (!suppressOnboarding && createdRoom) {
      onOpenRoom({ id: createdRoom.id, title: createdRoom.title, kind: createdRoom.kind })
    }
  }

  const applyFolderSetup = async () => {
    setSetupError(null)
    setMode('setup-saving')
    try {
      const sources = window.nxcore?.sources
      if (selectedFolders.length > 0) {
        if (!sources?.connectDefaultLocalFolders) throw new Error(t('contextRoom:onboarding.folderSetupFailed'))
        const results = await sources.connectDefaultLocalFolders(selectedFolders)
        const failed = results.filter((result) => !result.connected)
        if (results.length !== selectedFolders.length || failed.length === results.length) {
          throw new Error(t('contextRoom:onboarding.folderSetupFailed'))
        }
      }
      skipFolderSetup()
    } catch (cause) {
      setSetupError(cause instanceof Error ? cause.message : t('contextRoom:onboarding.folderSetupFailed'))
      setMode('setup')
    }
  }

  const addCustomFolder = async () => {
    const sources = window.nxcore?.sources
    if (!sources?.addLocalFolder) {
      setSetupError(t('contextRoom:onboarding.folderSetupFailed'))
      return
    }
    setSetupError(null)
    setMode('setup-saving')
    try {
      const result = await sources.addLocalFolder()
      if (result) {
        const folderName = result.source.name || result.source.rootPath
        setCustomFolders((current) => current.includes(folderName) ? current : [...current, folderName])
      }
      setMode('setup')
    } catch (cause) {
      setSetupError(cause instanceof Error ? cause.message : t('contextRoom:onboarding.folderSetupFailed'))
      setMode('setup')
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
          {!['success', 'setup-saving'].includes(mode) ? <button type="button" className="room-onboarding-skip" onClick={mode === 'setup' ? skipFolderSetup : skip}>{t('contextRoom:onboarding.skip')}</button> : null}
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
            <div className="room-onboarding-success-actions"><button type="button" className="room-onboarding-primary" onClick={openFolderSetup}>{t('contextRoom:onboarding.continueSetup')}<ArrowRight aria-hidden="true" /></button><button type="button" className="room-onboarding-secondary" onClick={skipFolderSetup}>{t('contextRoom:onboarding.skipSetup')}</button></div>
          </section>
        ) : null}
        {(mode === 'setup' || mode === 'setup-saving') && createdRoom ? (
          <section className="room-onboarding-setup" aria-labelledby="room-onboarding-setup-title" aria-busy={mode === 'setup-saving'}>
            <div className="room-onboarding-setup-heading"><div className="room-onboarding-setup-icon"><ShieldCheck aria-hidden="true" /></div><div><span>{t('contextRoom:onboarding.permissionsEyebrow')}</span><h1 id="room-onboarding-setup-title">{t('contextRoom:onboarding.permissionsTitle')}</h1><p>{t('contextRoom:onboarding.permissionsBody')}</p></div></div>
            <div className="room-onboarding-folder-panel">
              <div className="room-onboarding-folder-panel-header"><span>{t('contextRoom:onboarding.folderAccess')}</span><small>{t('contextRoom:onboarding.folderAccessHint')}</small></div>
              <label className="room-onboarding-folder-option"><input type="checkbox" checked={selectedFolders.includes('documents')} onChange={(event) => setSelectedFolders((current) => event.target.checked ? current.includes('documents') ? current : [...current, 'documents'] : current.filter((folder) => folder !== 'documents'))} /><span className="room-onboarding-folder-icon"><FolderOpen aria-hidden="true" /></span><span><strong>{t('contextRoom:onboarding.documentsFolder')}</strong><small>{t('contextRoom:onboarding.documentsFolderBody')}</small></span><Check aria-hidden="true" /></label>
              <label className="room-onboarding-folder-option"><input type="checkbox" checked={selectedFolders.includes('desktop')} onChange={(event) => setSelectedFolders((current) => event.target.checked ? current.includes('desktop') ? current : [...current, 'desktop'] : current.filter((folder) => folder !== 'desktop'))} /><span className="room-onboarding-folder-icon"><FolderOpen aria-hidden="true" /></span><span><strong>{t('contextRoom:onboarding.desktopFolder')}</strong><small>{t('contextRoom:onboarding.desktopFolderBody')}</small></span><Check aria-hidden="true" /></label>
              {customFolders.length > 0 ? <div className="room-onboarding-custom-folder-list"><span>{t('contextRoom:onboarding.customFolders')}</span>{customFolders.map((folder) => <div key={folder}><FolderOpen aria-hidden="true" /><strong>{folder}</strong></div>)}</div> : null}
              <button type="button" className="room-onboarding-custom-folder" disabled={mode === 'setup-saving'} onClick={() => void addCustomFolder()}><FolderPlus aria-hidden="true" /><span>{t('contextRoom:onboarding.addCustomFolder')}</span></button>
            </div>
            <p className="room-onboarding-setup-note">{t('contextRoom:onboarding.permissionsNote')}</p>
            <p className="room-onboarding-error" aria-live="polite">{setupError ?? '\u00a0'}</p>
            <div className="room-onboarding-success-actions"><button type="button" className="room-onboarding-primary" disabled={mode === 'setup-saving'} onClick={() => void applyFolderSetup()}>{mode === 'setup-saving' ? <LoaderCircle className="room-onboarding-inline-loader" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}{mode === 'setup-saving' ? t('contextRoom:onboarding.requestingPermissions') : t('contextRoom:onboarding.allowAndImport')}</button><button type="button" className="room-onboarding-secondary" disabled={mode === 'setup-saving'} onClick={skipFolderSetup}>{t('contextRoom:onboarding.skipSetup')}</button></div>
          </section>
        ) : null}
      </main>
    </div>
  )
}
