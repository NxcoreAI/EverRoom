export const DOCUMENT_BLOCK_REFERENCES_INVALIDATED_EVENT =
  'everroom:document-block-references-invalidated'

export interface DocumentBlockReferenceInvalidation {
  roomId?: string
  documentId?: string
  blockId?: string
}

export interface InvalidatableDocumentBlockReference {
  roomId: string
  documentId: string
  blockId: string
}

export function documentBlockReferenceInvalidationMatches(
  detail: DocumentBlockReferenceInvalidation,
  reference: InvalidatableDocumentBlockReference,
): boolean {
  return (!detail.roomId || detail.roomId === reference.roomId)
    && (!detail.documentId || detail.documentId === reference.documentId)
    && (!detail.blockId || detail.blockId === reference.blockId)
}

export function invalidateDocumentBlockReferences(
  detail: DocumentBlockReferenceInvalidation = {},
): void {
  window.dispatchEvent(new CustomEvent(DOCUMENT_BLOCK_REFERENCES_INVALIDATED_EVENT, { detail }))
}
