export interface DocumentFocusDecision {
  handledKey: string | null
  shouldOpen: boolean
}

export function consumeDocumentFocusRequest(
  handledKey: string | null,
  roomId: string,
  documentId: string | null,
  documentAvailable: boolean,
): DocumentFocusDecision {
  if (!documentId) return { handledKey: null, shouldOpen: false }

  const requestKey = `${roomId}\u0000${documentId}`
  if (!documentAvailable || handledKey === requestKey) {
    return { handledKey, shouldOpen: false }
  }

  return { handledKey: requestKey, shouldOpen: true }
}
