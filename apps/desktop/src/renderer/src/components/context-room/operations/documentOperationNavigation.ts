export const OPEN_DOCUMENT_OPERATION_EVENT = 'everroom:open-document-operation'

export interface DocumentOperationNavigationTarget {
  roomId: string
  documentId: string
  operationId: string
}

export function requestDocumentOperationNavigation(target: DocumentOperationNavigationTarget): void {
  window.dispatchEvent(new CustomEvent<DocumentOperationNavigationTarget>(OPEN_DOCUMENT_OPERATION_EVENT, { detail: target }))
}

export function onDocumentOperationNavigation(
  listener: (target: DocumentOperationNavigationTarget) => void,
): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<DocumentOperationNavigationTarget>).detail)
  window.addEventListener(OPEN_DOCUMENT_OPERATION_EVENT, handle)
  return () => window.removeEventListener(OPEN_DOCUMENT_OPERATION_EVENT, handle)
}
