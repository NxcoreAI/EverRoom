import { FolderPlus, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { ObsidianVaultCandidate } from '../../../../../shared/obsidian'
import { useLocale } from '@/i18n/LocaleContext'
import obsidianLogo from '@/assets/obsidian.svg'

export function ObsidianImportDialog({ target, roomName, onClose, onImported }: {
  target: { kind: 'memory' } | { kind: 'room'; roomId: string }
  roomName?: string
  onClose: () => void
  onImported: (result: Awaited<ReturnType<NonNullable<typeof window.nxcore>['obsidian']['importCandidate']>>) => void
}) {
  const { t } = useLocale()
  const [candidates, setCandidates] = useState<ObsidianVaultCandidate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    const api = window.nxcore?.obsidian
    if (!api) return
    setLoading(true)
    setError(null)
    try {
      const items = await api.discover()
      setCandidates(items)
      setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('surface:obsidian.discoveryFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

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
      const result = await window.nxcore.obsidian.importCandidate(selectedId, target)
      onImported(result)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('surface:obsidian.importFailed'))
    } finally {
      setImporting(false)
    }
  }

  const selected = candidates.find((item) => item.id === selectedId) ?? null
  const unavailableForRoom = target.kind === 'room'
    && Boolean(selected?.mountedRoomId)
    && selected?.mountedRoomId !== target.roomId

  return (
    <div className="evidence-dialog-backdrop obsidian-import-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !importing) onClose()
    }}>
      <section className="source-connect-dialog obsidian-import-dialog" role="dialog" aria-modal="true" aria-labelledby="obsidian-import-title">
        <header className="obsidian-import-header">
          <div>
            <span>{t('surface:obsidian.projectSource')}</span>
            <h2 id="obsidian-import-title">{t(target.kind === 'room' ? 'surface:obsidian.importIntoRoom' : 'surface:obsidian.importIntoMemory', { room: roomName ?? '' })}</h2>
            <p>{t(target.kind === 'room' ? 'surface:obsidian.roomImportHint' : 'surface:obsidian.memoryImportHint')}</p>
          </div>
          <button type="button" className="icon-button" aria-label={t('surface:obsidian.close')} onClick={onClose} disabled={importing}><X aria-hidden="true" /></button>
        </header>

        <div className="obsidian-import-toolbar">
          <button type="button" className="secondary-button" onClick={() => void addManual()} disabled={loading || importing}><FolderPlus aria-hidden="true" />{t('surface:obsidian.chooseManually')}</button>
          <button type="button" className="icon-button" title={t('surface:obsidian.refreshDiscovery')} aria-label={t('surface:obsidian.refreshDiscovery')} onClick={() => void refresh()} disabled={loading || importing}><RefreshCw aria-hidden="true" /></button>
        </div>

        <div className="obsidian-candidate-list" aria-busy={loading}>
          {loading ? <div className="obsidian-import-empty"><LoaderCircle className="is-spinning" aria-hidden="true" /><span>{t('surface:obsidian.discovering')}</span></div> : null}
          {!loading && candidates.length === 0 ? <div className="obsidian-import-empty"><img className="obsidian-app-icon" src={obsidianLogo} alt="" /><strong>{t('surface:obsidian.noVaultsFound')}</strong><span>{t('surface:obsidian.noVaultsFoundHint')}</span></div> : null}
          {!loading && candidates.map((candidate) => {
            const mountedElsewhere = target.kind === 'room' && Boolean(candidate.mountedRoomId) && candidate.mountedRoomId !== target.roomId
            const mountedHere = target.kind === 'room' && candidate.mountedRoomId === target.roomId
            return <label key={candidate.id} className="obsidian-candidate-row" data-disabled={mountedElsewhere || undefined}>
              <input type="radio" name="obsidian-vault" value={candidate.id} checked={selectedId === candidate.id} disabled={mountedElsewhere} onChange={() => setSelectedId(candidate.id)} />
              <span className="item-icon"><img className="obsidian-app-icon" src={obsidianLogo} alt="" /></span>
              <span className="obsidian-candidate-copy"><strong>{candidate.name}</strong><small>{t('surface:obsidian.candidateCounts', { notes: candidate.noteCount, attachments: candidate.attachmentCount })}</small></span>
              <span className="obsidian-candidate-meta">{mountedHere ? t('surface:obsidian.alreadyInThisRoom') : mountedElsewhere ? t('surface:obsidian.alreadyInAnotherRoom') : t(`surface:obsidian.discovery.${candidate.discoveredFrom}`)}</span>
            </label>
          })}
        </div>

        {error ? <div className="source-feedback" role="alert">{error}</div> : null}
        <footer className="obsidian-import-footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={importing}>{t('surface:inspiration.cancel')}</button>
          <button type="button" className="primary-button" onClick={() => void importSelected()} disabled={!selected || unavailableForRoom || importing}>
            {importing ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <img className="obsidian-app-icon" src={obsidianLogo} alt="" />}
            {t(importing ? 'surface:obsidian.importing' : target.kind === 'room' ? 'surface:obsidian.importToRoomAction' : 'surface:obsidian.importToMemoryAction')}
          </button>
        </footer>
      </section>
    </div>
  )
}
