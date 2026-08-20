import { ChevronRight, FileText, X } from 'lucide-react'

import type { AgentDocumentSelectionItem } from './agentDocumentSelection'
import { useLocale } from '@/i18n/LocaleContext'

export function AgentDocumentPicker({
  busy,
  documents,
  onCancel,
  onSelect,
}: {
  busy: boolean
  documents: AgentDocumentSelectionItem[]
  onCancel: () => void
  onSelect: (document: AgentDocumentSelectionItem) => void
}) {
  const { t } = useLocale()
  return (
    <section className="agent-room-selection agent-document-selection" aria-label={t('选择要编辑的文档')}>
      <header>
        <span><FileText aria-hidden="true" /><strong>{t('选择要编辑的文档')}</strong></span>
        <button type="button" aria-label={t('取消选择文档')} title={t('取消')} disabled={busy} onClick={onCancel}>
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
              <small>{t(document.status === 'draft' ? '草稿' : '文档')}</small>
            </span>
            <ChevronRight aria-hidden="true" />
          </button>
        )) : <p>{t('暂无可用文档')}</p>}
      </div>
    </section>
  )
}
