import { X } from 'lucide-react'

import type { ObsidianImportResult } from '../../../../../shared/obsidian'
import { useLocale } from '@/i18n/LocaleContext'
import { DirectoryMountPanel } from './DirectoryMountPanel'

export function ObsidianImportDialog({ target, roomName, onClose, onImported }: {
  target: { kind: 'memory'; enableRegistryAutoImport?: boolean } | { kind: 'room'; roomId: string }
  roomName?: string
  onClose: () => void
  onImported: (result: ObsidianImportResult) => void
}) {
  const { t } = useLocale()

  return (
    <div className="evidence-dialog-backdrop obsidian-import-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="source-connect-dialog obsidian-import-dialog" role="dialog" aria-modal="true" aria-labelledby="obsidian-import-title">
        <header className="obsidian-import-header">
          <div>
            <span>{t('surface:obsidian.projectSource')}</span>
            <h2 id="obsidian-import-title">{t(target.kind === 'room' ? 'surface:obsidian.importIntoRoom' : 'surface:obsidian.importIntoMemory', { room: roomName ?? '' })}</h2>
            <p>{t(target.kind === 'room' ? 'surface:obsidian.roomImportHint' : 'surface:obsidian.memoryImportHint')}</p>
          </div>
          <button type="button" className="icon-button" aria-label={t('surface:obsidian.close')} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <DirectoryMountPanel target={target} onClose={onClose} onImported={onImported} />
      </section>
    </div>
  )
}
