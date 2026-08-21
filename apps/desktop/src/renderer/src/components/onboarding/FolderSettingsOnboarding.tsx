import { Check, FolderOpen, FolderPlus, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import type { DefaultLocalFolder } from '../../../../shared/sources'
import './FolderSettingsOnboarding.css'

interface FolderSettingsOnboardingProps {
  open: boolean
  onClose: () => void
}

const DEFAULT_FOLDERS: DefaultLocalFolder[] = ['documents', 'desktop']

export function FolderSettingsOnboarding({ open, onClose }: FolderSettingsOnboardingProps) {
  const { t } = useLocale()
  const [selectedFolders, setSelectedFolders] = useState<DefaultLocalFolder[]>(DEFAULT_FOLDERS)
  const [customFolders, setCustomFolders] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSelectedFolders(DEFAULT_FOLDERS)
    setCustomFolders([])
    setBusy(false)
    setError(null)
  }, [open])

  const toggleFolder = (folder: DefaultLocalFolder, checked: boolean) => {
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
    const api = window.nxcore?.sources
    if (!api?.connectDefaultLocalFolders) {
      setError(t('surface:settings.folderGuide.unavailable'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (selectedFolders.length > 0) {
        const results = await api.connectDefaultLocalFolders(selectedFolders)
        const failed = results.filter((result) => !result.connected)
        if (failed.length > 0) throw new Error(t('surface:settings.folderGuide.failed'))
      }
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('surface:settings.folderGuide.failed'))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="folder-settings-onboarding" role="dialog" aria-modal="true" aria-labelledby="folder-settings-onboarding-title">
      <section className="folder-settings-onboarding-panel">
        <header className="folder-settings-onboarding-header">
          <div className="folder-settings-onboarding-heading">
            <span className="folder-settings-onboarding-icon"><ShieldCheck aria-hidden="true" /></span>
            <div>
              <span className="folder-settings-onboarding-eyebrow">{t('surface:settings.folderGuide.eyebrow')}</span>
              <h1 id="folder-settings-onboarding-title">{t('surface:settings.folderGuide.title')}</h1>
              <p>{t('surface:settings.folderGuide.body')}</p>
            </div>
          </div>
          <button type="button" className="folder-settings-onboarding-close" aria-label={t('surface:settings.folderGuide.close')} title={t('surface:settings.folderGuide.close')} onClick={onClose} disabled={busy}>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="folder-settings-onboarding-content">
          <div className="folder-settings-onboarding-folder-panel">
            <div className="folder-settings-onboarding-panel-heading">
              <strong>{t('surface:settings.folderGuide.scope')}</strong>
              <small>{t('surface:settings.folderGuide.scopeHint')}</small>
            </div>
            {DEFAULT_FOLDERS.map((folder) => (
              <label className="folder-settings-onboarding-option" key={folder}>
                <input type="checkbox" checked={selectedFolders.includes(folder)} onChange={(event) => toggleFolder(folder, event.target.checked)} disabled={busy} />
                <span className="folder-settings-onboarding-folder-icon"><FolderOpen aria-hidden="true" /></span>
                <span><strong>{t(`surface:settings.folderGuide.${folder}`)}</strong><small>{t(`surface:settings.folderGuide.${folder}Body`)}</small></span>
                <Check aria-hidden="true" />
              </label>
            ))}
            {customFolders.length > 0 ? (
              <div className="folder-settings-onboarding-custom-list">
                <span>{t('surface:settings.folderGuide.addedFolders')}</span>
                {customFolders.map((folder) => <div key={folder}><FolderOpen aria-hidden="true" /><strong>{folder}</strong></div>)}
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
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{t('surface:settings.folderGuide.later')}</button>
          <button type="button" className="primary-button" onClick={() => void apply()} disabled={busy}>
            {busy ? <LoaderCircle className="folder-settings-onboarding-spinner" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
            {busy ? t('surface:settings.folderGuide.saving') : t('surface:settings.folderGuide.save')}
          </button>
        </footer>
      </section>
    </div>
  )
}
