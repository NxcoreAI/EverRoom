import { ChevronRight, FileText, X } from 'lucide-react'

import type { AgentDocumentSelectionItem } from './agentDocumentSelection'
import { useLocale } from '@/i18n/LocaleContext'

export function AgentDocumentPicker({
  awaitingInput = true,
  busy,
  documents,
  onCancel,
  onSelect,
}: {
  /** agent 正挂着 run 等用户选（区别于「确认中」的 busy）。 */
  awaitingInput?: boolean
  busy: boolean
  documents: AgentDocumentSelectionItem[]
  onCancel: () => void
  onSelect: (document: AgentDocumentSelectionItem) => void
}) {
  const { t } = useLocale()
  return (
    <section
      className="agent-room-selection agent-document-selection"
      data-awaiting-input={String(awaitingInput && !busy)}
      aria-label={t('surface:agentDocumentPicker.chooseADocumentToEdit')}>
      <header>
        <span><FileText aria-hidden="true" /><strong>{t('surface:agentDocumentPicker.chooseADocumentToEdit')}</strong></span>
        <button type="button" aria-label={t('surface:agentDocumentPicker.cancelDocumentSelection')} title={t('surface:agentDocumentPicker.cancel')} disabled={busy} onClick={onCancel}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="agent-room-selection-list">
        {documents.length ? documents.map((document) => (
          <button
            key={`${document.roomId}:${document.documentId}`}
            type="button"
            disabled={busy}
            title={document.title}
            onClick={() => onSelect(document)}
          >
            <FileText aria-hidden="true" />
            <span>
              <strong>{document.title}</strong>
              <small>{t(document.status === 'draft' ? 'surface:agentDocumentPicker.draft' : 'surface:agentDocumentPicker.documents')}</small>
            </span>
            <ChevronRight aria-hidden="true" />
          </button>
        )) : <p>{t('surface:agentDocumentPicker.noDocumentsAvailable')}</p>}
      </div>
    </section>
  )
}
