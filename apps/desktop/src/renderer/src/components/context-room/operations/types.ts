import type {
  DocumentOperation,
  DocumentOperationStatus,
  DocumentOperationSummary,
  RoomDocument,
  StartDocumentOperationInput,
} from '@nxcore/agent-contract'

export type DocumentOperationDecision = 'accepted' | 'rejected'
export type DocumentOperationDecisionMap = Record<string, DocumentOperationDecision | undefined>

export interface DocumentOperationEntry {
  id: string
  summary: DocumentOperationSummary
  detail: DocumentOperation | null
  decisions: DocumentOperationDecisionMap
  busy: boolean
  error?: DocumentOperationActionError
  revision: number
}

export type DocumentOperationActionErrorKind = 'conflict' | 'not-found' | 'network'

export interface DocumentOperationActionError {
  kind: DocumentOperationActionErrorKind
  messageKey: string
}

export function classifyDocumentOperationError(error: unknown): DocumentOperationActionError {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : null
  const response = value?.response && typeof value.response === 'object'
    ? value.response as Record<string, unknown>
    : null
  const data = response?.data && typeof response.data === 'object'
    ? response.data as Record<string, unknown>
    : null
  const status = typeof response?.status === 'number' ? response.status : null
  const code = [value?.code, data?.code, data?.error]
    .find((candidate) => typeof candidate === 'string') as string | undefined
  const rawMessage = typeof value?.message === 'string' ? value.message : ''
  const signature = `${code ?? ''} ${rawMessage}`.toUpperCase()
  if (
    status === 409
    || signature.includes('CONFLICT')
    || signature.includes('VERSION_MISMATCH')
    || signature.includes('VERSION HAS CHANGED')
    || signature.includes('版本已经变化')
    || signature.includes('版本已变化')
  ) return { kind: 'conflict', messageKey: 'contextRoom:documentOperationErrors.conflict' }
  if (status === 404 || signature.includes('NOT_FOUND') || signature.includes('NOT FOUND')) {
    return { kind: 'not-found', messageKey: 'contextRoom:documentOperationErrors.notFound' }
  }
  return { kind: 'network', messageKey: 'contextRoom:documentOperationErrors.network' }
}

export interface DocumentOperationListFilters {
  roomId?: string
  documentId?: string
  sessionId?: string
  capabilityId?: string
  statuses?: DocumentOperationStatus[]
}

export interface DocumentOperationCommand {
  commandId: string
  expectedRevision: number
  type: string
  payload?: Record<string, unknown>
}

export interface DocumentOperationCommandResult {
  operation: DocumentOperation
  document?: RoomDocument
}

export interface OperationBridge {
  list(filters?: DocumentOperationListFilters): Promise<DocumentOperationSummary[]>
  start?(input: StartDocumentOperationInput): Promise<DocumentOperation>
  get(operationId: string): Promise<DocumentOperation | null>
  command(operationId: string, command: DocumentOperationCommand): Promise<DocumentOperationCommandResult | null>
  subscribe?(listener: (operationId: string) => void): () => void
}
