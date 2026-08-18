import type { DocumentOperationStatus, RoomDocument } from '@nxcore/agent-contract'

import { hasVisibleTiptapContent } from './markdownStream'

export type OperationStreamBaselineKind = 'authoritative-draft' | 'historical-completion'

type OperationStreamIdentity = {
  operationId: string
  status: DocumentOperationStatus
}

type OperationStreamPresentation = OperationStreamIdentity & {
  active: boolean
}

type InitializedStreamDocument = Pick<
  RoomDocument,
  'activeTransactionId' | 'contentJson' | 'id' | 'status'
>

export function operationStreamBaselineKind(
  operation: OperationStreamIdentity,
  documentId: string,
  initializedDocument: InitializedStreamDocument | null,
  wasActiveDuringCurrentMount: boolean,
): OperationStreamBaselineKind | null {
  if (operation.status === 'completed' && !wasActiveDuringCurrentMount) {
    return 'historical-completion'
  }
  if (!initializedDocument || initializedDocument.id !== documentId) return null

  if (initializedDocument.status === 'draft') {
    return initializedDocument.activeTransactionId === operation.operationId
      && hasVisibleTiptapContent(initializedDocument.contentJson)
      ? 'authoritative-draft'
      : null
  }

  return null
}

export function operationStreamNeedsPresentation(
  operation: OperationStreamPresentation | null,
  settledOperationId: string | null,
  baselineKind: OperationStreamBaselineKind | null,
  wasActiveDuringCurrentMount: boolean,
): boolean {
  if (!operation) return false
  if (operation.active) return true
  if (operation.status !== 'completed' || settledOperationId === operation.operationId) return false

  return baselineKind !== 'historical-completion' || wasActiveDuringCurrentMount
}
