import type { DocumentBlockList, DocumentBlockSummary, RoomDocument } from '@nxcore/agent-contract'
import { FileText, Link2, LoaderCircle, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'

import type { DocumentBlockReferenceAttrs } from './documentBlockReferenceLink'
import './DocumentBlockReference.css'

export interface DocumentBlockReferencePickerProps {
  roomId: string
  documents: RoomDocument[]
  currentDocumentId?: string | null
  listBlocks: (documentId: string) => Promise<DocumentBlockList>
  onSelect: (reference: DocumentBlockReferenceAttrs) => void
  onClose: () => void
}

export function DocumentBlockReferencePicker({
  roomId,
  documents,
  currentDocumentId,
  listBlocks,
  onSelect,
  onClose,
}: DocumentBlockReferencePickerProps) {
  const { t } = useLocale()
  const availableDocuments = useMemo(
    () => documents.filter((document) => document.roomId === roomId && !document.deletedAt),
    [documents, roomId],
  )
  const [selectedDocumentId, setSelectedDocumentId] = useState(
    currentDocumentId && availableDocuments.some((document) => document.id === currentDocumentId)
      ? currentDocumentId
      : availableDocuments[0]?.id ?? '',
  )
  const [blocks, setBlocks] = useState<DocumentBlockSummary[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (availableDocuments.some((document) => document.id === selectedDocumentId)) return
    setSelectedDocumentId(availableDocuments[0]?.id ?? '')
  }, [availableDocuments, selectedDocumentId])

  useEffect(() => {
    if (!selectedDocumentId) {
      setBlocks([])
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void listBlocks(selectedDocumentId).then(
      (result) => {
        if (!cancelled) {
          setBlocks(result.documentId === selectedDocumentId && result.roomId === roomId
            ? result.blocks.filter((block) => block.roomId === roomId)
            : [])
        }
      },
      () => {
        if (!cancelled) {
          setBlocks([])
          setError(t('contextRoom:documentBlockReferencePicker.unableToLoadDocumentBlocksTryAgainLater'))
        }
      },
    ).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [listBlocks, roomId, selectedDocumentId, t])

  const selectedDocument = availableDocuments.find((document) => document.id === selectedDocumentId)
  const filteredBlocks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return blocks
    return blocks.filter((block) => `${block.type} ${block.textPreview}`.toLocaleLowerCase().includes(normalized))
  }, [blocks, query])

  return (
    <div className="context-room-reference-picker-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="context-room-reference-picker"
        role="dialog"
        aria-modal="true"
        aria-label={t('contextRoom:documentBlockReferencePicker.referenceDocumentBlock')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span><Link2 aria-hidden="true" />{t('contextRoom:documentBlockReferencePicker.referenceDocumentBlock')}</span>
          <button type="button" aria-label={t('contextRoom:documentBlockReferencePicker.close')} title={t('contextRoom:documentBlockReferencePicker.close')} onClick={onClose}><X /></button>
        </header>
        <div className="context-room-reference-picker-body">
          <nav aria-label={t('contextRoom:documentBlockReferencePicker.selectDocument')}>
            {availableDocuments.map((document) => (
              <button
                type="button"
                key={document.id}
                data-selected={String(document.id === selectedDocumentId)}
                onClick={() => setSelectedDocumentId(document.id)}
              >
                <FileText aria-hidden="true" />
                <span>{document.title}</span>
              </button>
            ))}
            {availableDocuments.length === 0 ? <p>{t('contextRoom:documentBlockReferencePicker.thisRoomHasNoDocumentsAvailableToReference')}</p> : null}
          </nav>
          <main>
            <label>
              <Search aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('contextRoom:documentBlockReferencePicker.searchBlocks')}
                aria-label={t('contextRoom:documentBlockReferencePicker.searchBlocks')}
              />
            </label>
            <div className="context-room-reference-picker-blocks">
              {loading ? <p><LoaderCircle className="is-spinning" />{t('contextRoom:documentBlockReferencePicker.loadingBlocks')}</p> : null}
              {!loading && error ? <p data-error="true">{error}</p> : null}
              {!loading && !error && filteredBlocks.map((block) => (
                <button
                  type="button"
                  key={block.blockId}
                  onClick={() => {
                    if (!selectedDocument) return
                    onSelect({
                      roomId,
                      documentId: selectedDocument.id,
                      blockId: block.blockId,
                      fallbackTitle: selectedDocument.title,
                      fallbackPreview: block.textPreview,
                    })
                  }}
                >
                  <span>{block.textPreview || t('contextRoom:documentBlockReferencePicker.emptyBlock')}</span>
                  <small>{block.type}</small>
                </button>
              ))}
              {!loading && !error && selectedDocument && filteredBlocks.length === 0 ? (
                <p>{t(query ? 'contextRoom:documentBlockReferencePicker.noMatchingBlocks' : 'contextRoom:documentBlockReferencePicker.noReferenceBlocks')}</p>
              ) : null}
            </div>
          </main>
        </div>
      </section>
    </div>
  )
}
