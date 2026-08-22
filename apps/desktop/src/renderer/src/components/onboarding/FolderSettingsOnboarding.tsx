import {
  Check,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Languages,
  LoaderCircle,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { ProductBrand } from '@/components/ui/ProductBrand'
import { useLocale } from '@/i18n/LocaleContext'
import type { DefaultLocalFolder } from '../../../../shared/sources'
import './FolderSettingsOnboarding.css'

interface FolderSettingsOnboardingProps {
  open: boolean
  onClose: () => void
  memoryReady?: boolean
  showReady?: boolean
  onNavigateStage?: (stage: 'memory' | 'room' | 'folder' | 'ready') => void
}

const DEFAULT_FOLDERS: DefaultLocalFolder[] = ['documents', 'desktop']

export function FolderSettingsOnboarding({ open, onClose, memoryReady = false, showReady = false, onNavigateStage }: FolderSettingsOnboardingProps) {
  const { locale, setLocale, t } = useLocale()
  const [selectedFolders, setSelectedFolders] = useState<DefaultLocalFolder[]>([])
  const [connectedFolders, setConnectedFolders] = useState<DefaultLocalFolder[]>([])
  const [failedFolders, setFailedFolders] = useState<DefaultLocalFolder[]>([])
  const [customFolders, setCustomFolders] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [mode, setMode] = useState<'form' | 'ready'>('form')
  const [error, setError] = useState<string | null>(null)

  const allConnected = useMemo(
    () => DEFAULT_FOLDERS.every((folder) => connectedFolders.includes(folder)),
    [connectedFolders],
  )
  const hasConfiguredScope = allConnected || customFolders.length > 0
  const hasPendingFolders = selectedFolders.some((folder) => !connectedFolders.includes(folder))

  useEffect(() => {
    console.info('[onboarding] folder-mode', { open, showReady, mode })
  }, [mode, open, showReady])

  useEffect(() => {
    if (!open) return
    setSelectedFolders([])
    setConnectedFolders([])
    setFailedFolders([])
    setCustomFolders([])
    setBusy(false)
    setMode(showReady ? 'ready' : 'form')
    setChecking(true)
    setError(null)
    const api = window.nxcore?.sources
    if (!api?.listDefaultLocalFolders) {
      setChecking(false)
      setError(t('surface:settings.folderGuide.unavailable'))
      return
    }
    void api.listDefaultLocalFolders().then((statuses) => {
      const connected = statuses.filter((item) => item.connected).map((item) => item.folder)
      setConnectedFolders(connected)
      setSelectedFolders(DEFAULT_FOLDERS)
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : t('surface:settings.folderGuide.failed'))
    }).finally(() => setChecking(false))
  }, [open, showReady, t])

  const toggleFolder = (folder: DefaultLocalFolder, checked: boolean) => {
    if (connectedFolders.includes(folder)) return
    setSelectedFolders((current) => checked
      ? current.includes(folder) ? current : [...current, folder]
      : current.filter((item) => item !== folder))
  }

  const addCustomFolder = async () => {
    const api = window.nxcore?.sources
    if (!api?.addLocalFolder) {
      setError(t('surface:settings.folderGuide.unavailable'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api.addLocalFolder()
      if (result) {
        const name = result.source.name || result.source.rootPath
        setCustomFolders((current) => current.includes(name) ? current : [...current, name])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('surface:settings.folderGuide.failed'))
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    console.info('[onboarding] folder-apply', { hasConfiguredScope, hasPendingFolders, showReady })
    const api = window.nxcore?.sources
    if (!api?.connectDefaultLocalFolders) {
      setError(t('surface:settings.folderGuide.unavailable'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const pending = selectedFolders.filter((folder) => !connectedFolders.includes(folder))
      if (pending.length > 0) {
        const results = await api.connectDefaultLocalFolders(pending)
        const successful = results.filter((result) => result.connected).map((result) => result.folder)
        const failed = results.filter((result) => !result.connected).map((result) => result.folder)
        setConnectedFolders((current) => [...new Set([...current, ...successful])])
        setFailedFolders(failed)
        if (failed.length > 0) throw new Error(t('surface:settings.folderGuide.failed'))
      }
      console.info('[onboarding] folder-apply-success', { destination: 'memory' })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('surface:settings.folderGuide.failed'))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="folder-settings-onboarding" data-mac-desktop={String(window.nxcore?.platform === 'darwin')}>
      <header className="folder-settings-onboarding-header drag-region">
        <ProductBrand className="folder-settings-onboarding-brand" />
        <div className="folder-settings-onboarding-actions no-drag">
          <div className="folder-settings-onboarding-language" role="group" aria-label={t('contextRoom:onboarding.language')}>
            <Languages aria-hidden="true" />
            <button type="button" data-active={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>中文</button>
            <button type="button" data-active={locale === 'en-US'} onClick={() => setLocale('en-US')}>EN</button>
          </div>
        </div>
      </header>
      <main className="folder-settings-onboarding-main" aria-live="polite">
        <nav className="folder-settings-onboarding-sequence" aria-label={t('surface:settings.folderGuide.eyebrow')}>
          <span role="button" tabIndex={0} data-state="complete" onClick={() => onNavigateStage?.('memory')} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onNavigateStage?.('memory') }}><Check aria-hidden="true" />{t('memory:onboarding.memorySetup')}</span>
          <ChevronRight aria-hidden="true" />
          <span role="button" tabIndex={0} data-state="complete" onClick={() => onNavigateStage?.('room')} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onNavigateStage?.('room') }}><Check aria-hidden="true" />{t('contextRoom:onboarding.eyebrow')}</span>
          <ChevronRight aria-hidden="true" />
          <span data-state={mode === 'ready' ? 'complete' : 'active'}><ShieldCheck aria-hidden="true" />{t('surface:settings.folderGuide.eyebrow')}</span>
          <ChevronRight aria-hidden="true" />
          <span role="button" tabIndex={0} data-state={mode === 'ready' ? 'active' : 'upcoming'} onClick={() => onNavigateStage?.('ready')} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onNavigateStage?.('ready') }}><Check aria-hidden="true" />{t('surface:settings.folderGuide.readyTitle')}</span>
        </nav>
        {checking ? (
          <section className="folder-settings-onboarding-status" aria-busy="true">
            <LoaderCircle className="folder-settings-onboarding-loading-icon" aria-hidden="true" />
            <h1>{t('surface:settings.folderGuide.checking')}</h1>
          </section>
        ) : mode === 'ready' ? (
          <section className="folder-settings-onboarding-ready" aria-labelledby="folder-settings-onboarding-ready-title">
            <Check className="folder-settings-onboarding-ready-icon" aria-hidden="true" />
            <h1 id="folder-settings-onboarding-ready-title">{t('surface:settings.folderGuide.readyTitle')}</h1>
            <p>{t('surface:settings.folderGuide.readyBody')}</p>
            <button type="button" className="folder-settings-onboarding-primary" onClick={onClose}>
              {t('surface:settings.folderGuide.enter')}<ChevronRight aria-hidden="true" />
            </button>
          </section>
        ) : (
          <section className="folder-settings-onboarding-card" aria-labelledby="folder-settings-onboarding-title">
            <div className="folder-settings-onboarding-content">
              <h1 id="folder-settings-onboarding-title">{t('surface:settings.folderGuide.title')}</h1>
              <p className="folder-settings-onboarding-body">{t('surface:settings.folderGuide.body')}</p>
              <div className="folder-settings-onboarding-folder-panel">
                <div className="folder-settings-onboarding-panel-heading">
                  <strong>{t('surface:settings.folderGuide.scope')}</strong>
                </div>
                {DEFAULT_FOLDERS.map((folder) => {
                  const connected = connectedFolders.includes(folder)
                  return (
                    <label className="folder-settings-onboarding-option" key={folder} data-connected={String(connected)}>
                      <input type="checkbox" checked={selectedFolders.includes(folder)} onChange={(event) => toggleFolder(folder, event.target.checked)} disabled={busy || connected} />
                      <span className="folder-settings-onboarding-folder-icon"><FolderOpen aria-hidden="true" /></span>
                      <span><strong>{t(`surface:settings.folderGuide.${folder}`)}</strong></span>
                      {connected ? <Check aria-hidden="true" /> : <X className="folder-settings-onboarding-failed-icon" aria-hidden="true" />}
                    </label>
                  )
                })}
                {customFolders.length > 0 ? (
                  <div className="folder-settings-onboarding-custom-list">
                    <span>{t('surface:settings.folderGuide.addedFolders')}</span>
                    {customFolders.map((folder) => <div key={folder}><FolderOpen aria-hidden="true" /><strong>{folder}</strong><Check aria-hidden="true" /></div>)}
                  </div>
                ) : null}
                <button type="button" className="folder-settings-onboarding-add" onClick={() => void addCustomFolder()} disabled={busy}>
                  {busy ? <LoaderCircle className="folder-settings-onboarding-spinner" aria-hidden="true" /> : <FolderPlus aria-hidden="true" />}
                  {t('surface:settings.folderGuide.addFolder')}
                </button>
              </div>
              <p className="folder-settings-onboarding-note">{t('surface:settings.folderGuide.note')}</p>
              <p className="folder-settings-onboarding-error" role="alert" aria-live="polite">{error ?? '\u00a0'}</p>
            </div>
            <footer className="folder-settings-onboarding-actions">
              <button type="button" className="folder-settings-onboarding-primary" onClick={() => void apply()} disabled={busy || (!hasConfiguredScope && selectedFolders.length === 0)}>
                {busy ? <LoaderCircle className="folder-settings-onboarding-spinner" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                {busy ? t('surface:settings.folderGuide.saving') : hasPendingFolders ? t('surface:settings.folderGuide.save') : t('surface:settings.folderGuide.continue')}
                {!busy ? <ChevronRight aria-hidden="true" /> : null}
              </button>
            </footer>
          </section>
        )}
      </main>
      {memoryReady ? <div className="folder-settings-onboarding-memory-status"><Check aria-hidden="true" />{t('memory:onboarding.memoryGenerated')}</div> : null}
    </div>
  )
}
