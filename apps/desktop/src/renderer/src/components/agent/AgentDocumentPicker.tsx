import { ChevronRight, FileText, X } from 'lucide-react'

import type { AgentDocumentSelectionItem } from './agentDocumentSelection'

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
  return (
    <section className="agent-room-selection agent-document-selection" aria-label="选择要编辑的文档">
      <header>
        <span><FileText aria-hidden="true" /><strong>选择要编辑的文档</strong></span>
        <button type="button" aria-label="取消选择文档" title="取消" disabled={busy} onClick={onCancel}>
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
              <small>{document.status === 'draft' ? '草稿' : '文档'}</small>
            </span>
            <ChevronRight aria-hidden="true" />
          </button>
        )) : <p>暂无可用文档</p>}
      </div>
    </section>
  )
}
