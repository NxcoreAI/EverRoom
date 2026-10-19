import { Folder, FolderPlus, LoaderCircle, RefreshCw } from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'

import type { ObsidianImportResult, ObsidianImportTarget, ObsidianVaultCandidate } from '../../../../../shared/obsidian'
import { useLocale } from '@/i18n/LocaleContext'
import obsidianLogo from '@/assets/obsidian.svg'

export type DirectoryMountTarget = ObsidianImportTarget | { kind: 'choose' }

/**
 * 目录挂载面板：候选列表 + 手动选择 +（choose 模式下的）挂法选择。
 * 以 Fragment 输出 toolbar/list/feedback/footer 四段，供 sources 对话框 grid
 * 与新建房间工作室两种宿主复用。
 */
export function DirectoryMountPanel({ target, onClose, onImported }: {
  target: DirectoryMountTarget
  onClose: () => void
  onImported: (result: ObsidianImportResult) => void
}) {
  const { t } = useLocale()
  const [candidates, setCandidates] = useState<ObsidianVaultCandidate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mountChoice, setMountChoice] = useState<'new-room' | 'memory'>('new-room')
  const discoveryRequestRef = useRef(0)

  const effectiveTarget: ObsidianImportTarget = target.kind === 'choose'
    ? mountChoice === 'memory' ? { kind: 'memory' } : { kind: 'new-room' }
    : target

  const refresh = useCallback(async () => {
    const api = window.nxcore?.obsidian
    if (!api) return
    const request = ++discoveryRequestRef.current
    setLoading(true)
    setError(null)
    try {
      const items = await api.discover()
      if (request !== discoveryRequestRef.current) return
      setCandidates(items)
      setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null)
    } catch (caught) {
      if (request !== discoveryRequestRef.current) return
      setError(caught instanceof Error ? caught.message : t('surface:obsidian.discoveryFailed'))
    } finally {
      if (request === discoveryRequestRef.current) setLoading(false)
    }
  }, [t])

  useEffect(() => {
    const obsidian = window.nxcore?.obsidian
    if (!obsidian) return
    const unsubscribe = obsidian.onDiscoveryChanged(() => void refresh())
    void refresh()
    return () => {
      discoveryRequestRef.current += 1
      unsubscribe()
    }
  }, [refresh])

  const addManual = async () => {
    const candidate = await window.nxcore?.obsidian.pickCandidate()
    if (!candidate) return
    setCandidates((current) => [candidate, ...current.filter((item) => item.id !== candidate.id)])
    setSelectedId(candidate.id)
  }

  const importSelected = async () => {
    if (!selectedId || !window.nxcore?.obsidian) return
    setImporting(true)
    setError(null)
    try {
      const result = await window.nxcore.obsidian.importCandidate(selectedId, effectiveTarget)
      onImported(result)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('surface:obsidian.importFailed'))
    } finally {
      setImporting(false)
    }
  }

  const rowUnavailable = (candidate: ObsidianVaultCandidate): boolean => {
    if (effectiveTarget.kind === 'room') {
      return Boolean(candidate.mountedRoomId) && candidate.mountedRoomId !== effectiveTarget.roomId
    }
    if (effectiveTarget.kind === 'new-room') return Boolean(candidate.mountedRoomId)
    return false
  }

  const rowMeta = (candidate: ObsidianVaultCandidate): string => {
    if (effectiveTarget.kind === 'room' && candidate.mountedRoomId === effectiveTarget.roomId) {
      return t('surface:obsidian.alreadyInThisRoom')
    }
    if (effectiveTarget.kind === 'new-room' && candidate.mountedRoomId) {
      return t('surface:obsidian.alreadyMounted')
    }
    if (rowUnavailable(candidate)) return t('surface:obsidian.alreadyInAnotherRoom')
    return t(`surface:obsidian.discovery.${candidate.discoveredFrom}`)
  }

  const selected = candidates.find((item) => item.id === selectedId) ?? null
  const selectedUnavailable = selected ? rowUnavailable(selected) : false
  const actionLabel = importing
    ? t('surface:obsidian.importing')
    : effectiveTarget.kind === 'room'
      ? t('surface:obsidian.importToRoomAction')
      : effectiveTarget.kind === 'new-room'
        ? t('surface:obsidian.importToNewRoomAction')
        : t('surface:obsidian.importToMemoryAction')

  return (
    <Fragment>
      <div className="obsidian-import-toolbar">
        {target.kind === 'choose' ? (
          <div className="obsidian-import-mode" role="radiogroup" aria-label={t('contextRoom:creation.mountModeLabel')}>
            <label>
              <input type="radio" name="directory-mount-mode" checked={mountChoice === 'new-room'} onChange={() => setMountChoice('new-room')} />
              {t('contextRoom:creation.mountModeNewRoom')}
            </label>
            <label>
              <input type="radio" name="directory-mount-mode" checked={mountChoice === 'memory'} onChange={() => setMountChoice('memory')} />
              {t('contextRoom:creation.mountModeMemory')}
            </label>
          </div>
        ) : <span />}
        <span className="obsidian-import-toolbar-actions">
          <button type="button" className="secondary-button" onClick={() => void addManual()} disabled={loading || importing}><FolderPlus aria-hidden="true" />{t('surface:obsidian.chooseManually')}</button>
          <button type="button" className="icon-button" title={t('surface:obsidian.refreshDiscovery')} aria-label={t('surface:obsidian.refreshDiscovery')} onClick={() => void refresh()} disabled={loading || importing}><RefreshCw aria-hidden="true" /></button>
        </span>
      </div>

      <div className="obsidian-candidate-list" aria-busy={loading}>
        {loading ? <div className="obsidian-import-empty"><LoaderCircle className="is-spinning" aria-hidden="true" /><span>{t('surface:obsidian.discovering')}</span></div> : null}
        {!loading && candidates.length === 0 ? <div className="obsidian-import-empty"><Folder aria-hidden="true" /><strong>{t('surface:obsidian.noVaultsFound')}</strong><span>{t('surface:obsidian.noVaultsFoundHint')}</span></div> : null}
        {!loading && candidates.map((candidate) => {
          const unavailable = rowUnavailable(candidate)
          return (
            <label key={candidate.id} className="obsidian-candidate-row" data-disabled={unavailable || undefined}>
              <input type="radio" name="obsidian-vault" value={candidate.id} checked={selectedId === candidate.id} disabled={unavailable} onChange={() => setSelectedId(candidate.id)} />
              <span className="item-icon">{candidate.sourceType === 'obsidian-vault'
                ? <img className="obsidian-app-icon" src={obsidianLogo} alt="" />
                : <Folder aria-hidden="true" />}
              </span>
              <span className="obsidian-candidate-copy">
                <strong>{candidate.name}</strong>
                <small>{t('surface:obsidian.candidateCounts', { notes: candidate.noteCount, attachments: candidate.attachmentCount })}</small>
              </span>
              <span className="obsidian-candidate-meta">{rowMeta(candidate)}</span>
            </label>
          )
        })}
      </div>

      {error ? <div className="source-feedback" role="alert">{error}</div> : null}
      <footer className="obsidian-import-footer">
        <button type="button" className="secondary-button" onClick={onClose} disabled={importing}>{t('surface:inspiration.cancel')}</button>
        <button type="button" className="primary-button" onClick={() => void importSelected()} disabled={!selected || selectedUnavailable || importing}>
          {importing ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Folder aria-hidden="true" />}
          {actionLabel}
        </button>
      </footer>
    </Fragment>
  )
}
