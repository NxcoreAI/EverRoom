export const OPEN_DOCUMENT_PATCH_EVENT = 'everroom:open-document-patch'

export interface DocumentPatchNavigationTarget {
  roomId: string
  documentId: string
  patchId: string
}

export function requestDocumentPatchNavigation(target: DocumentPatchNavigationTarget): void {
  window.dispatchEvent(new CustomEvent<DocumentPatchNavigationTarget>(OPEN_DOCUMENT_PATCH_EVENT, { detail: target }))
}

export function onDocumentPatchNavigation(
  listener: (target: DocumentPatchNavigationTarget) => void,
): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<DocumentPatchNavigationTarget>).detail)
  window.addEventListener(OPEN_DOCUMENT_PATCH_EVENT, handle)
  return () => window.removeEventListener(OPEN_DOCUMENT_PATCH_EVENT, handle)
}
