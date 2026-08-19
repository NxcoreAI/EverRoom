import type { DocumentBlockReferenceInput } from '@nxcore/agent-contract'

export const OPEN_DOCUMENT_BLOCK_EVENT = 'everroom:open-document-block'

export function requestDocumentBlockNavigation(target: DocumentBlockReferenceInput): void {
  window.dispatchEvent(new CustomEvent<DocumentBlockReferenceInput>(OPEN_DOCUMENT_BLOCK_EVENT, { detail: target }))
}

export function onDocumentBlockNavigation(
  listener: (target: DocumentBlockReferenceInput) => void,
): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<DocumentBlockReferenceInput>).detail)
  window.addEventListener(OPEN_DOCUMENT_BLOCK_EVENT, handle)
  return () => window.removeEventListener(OPEN_DOCUMENT_BLOCK_EVENT, handle)
}

export interface DocumentBlockNavigationPlan {
  requestKey: string
  handledKey: string | null
  shouldOpenDocument: boolean
  shouldFocusBlock: boolean
  documentUnavailable: boolean
}

export type DocumentBlockFocusResult = 'focused' | 'block_missing' | 'editor_unavailable'

export function documentBlockNavigationKey(target: DocumentBlockReferenceInput): string {
  return `${target.roomId}\u0000${target.documentId}\u0000${target.blockId}`
}

export function documentBlockFocusRequestKey(
  documentId: string,
  blockId: string,
  requestId: number | null | undefined,
): string {
  return `${documentId}\u0000${blockId}\u0000${requestId ?? 'legacy'}`
}

export function planDocumentBlockNavigation(
  handledKey: string | null,
  target: DocumentBlockReferenceInput,
  currentRoomId: string | null,
  currentDocumentId: string | null,
  documentAvailable: boolean,
): DocumentBlockNavigationPlan {
  const requestKey = documentBlockNavigationKey(target)
  if (handledKey === requestKey) {
    return {
      requestKey,
      handledKey,
      shouldOpenDocument: false,
      shouldFocusBlock: false,
      documentUnavailable: false,
    }
  }
  if (!documentAvailable) {
    return {
      requestKey,
      handledKey: requestKey,
      shouldOpenDocument: false,
      shouldFocusBlock: false,
      documentUnavailable: true,
    }
  }
  const documentIsOpen = currentRoomId === target.roomId && currentDocumentId === target.documentId
  return {
    requestKey,
    handledKey: documentIsOpen ? requestKey : handledKey,
    shouldOpenDocument: !documentIsOpen,
    shouldFocusBlock: documentIsOpen,
    documentUnavailable: false,
  }
}

export function findDocumentBlockElement(
  editorRoot: ParentNode,
  blockId: string,
): HTMLElement | null {
  for (const element of editorRoot.querySelectorAll<HTMLElement>('[data-block-id]')) {
    if (element.getAttribute('data-block-id') === blockId) return element
  }
  return null
}

export function focusDocumentBlock(
  editorRoot: ParentNode | null,
  blockId: string,
  options: { flashDurationMs?: number; onFlashEnd?: () => void } = {},
): DocumentBlockFocusResult {
  if (!editorRoot) return 'editor_unavailable'
  const block = findDocumentBlockElement(editorRoot, blockId)
  if (!block) return 'block_missing'

  block.scrollIntoView({ block: 'center', behavior: 'smooth' })
  block.setAttribute('data-reference-target', 'true')
  const duration = options.flashDurationMs ?? 1_800
  window.setTimeout(() => {
    block.removeAttribute('data-reference-target')
    options.onFlashEnd?.()
  }, duration)
  return 'focused'
}
