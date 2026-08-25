import type { DocumentOperationStatus, DocumentOperationSummary } from '@nxcore/agent-contract'
import i18n from '@/i18n/i18next'

import type { DocumentOperationListFilters, OperationBridge } from './types'

function uniqueStatuses(statuses: DocumentOperationStatus[] | undefined): Array<DocumentOperationStatus | undefined> {
  return statuses?.length ? [...new Set(statuses)] : [undefined]
}

export function createDesktopOperationBridge(
  documents: NonNullable<typeof window.nxcore>['documents'],
): OperationBridge {
  return {
    async list(filters: DocumentOperationListFilters = {}) {
      const pages = await Promise.all(uniqueStatuses(filters.statuses).map((status) => documents.listOperations({
        ...(filters.roomId ? { roomId: filters.roomId } : {}),
        ...(filters.documentId ? { documentId: filters.documentId } : {}),
        ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
        ...(status ? { status } : {}),
      })))
      const operations = new Map<string, DocumentOperationSummary>()
      for (const page of pages) {
        for (const operation of page) operations.set(operation.id, operation)
      }
      return [...operations.values()]
        .filter((operation) => !filters.capabilityId || operation.capabilityId === filters.capabilityId)
        .filter((operation) => !filters.sessionId || operation.sessionId === filters.sessionId)
        .filter((operation) => !filters.statuses || filters.statuses.includes(operation.status))
    },
    start: (input) => documents.startOperation(input),
    get: (operationId, context) => documents.getOperation(operationId, context),
    command: (operationId, command) => documents.executeOperationCommand(operationId, command),
    subscribe: (listener) => documents.onOperationChanged(listener),
    subscribeReady: (listener) => documents.onReady?.(() => listener()) ?? (() => undefined),
  }
}

function unavailableOperationBridge(): OperationBridge {
  const unavailable = () => Promise.reject(new Error(i18n.t('surface:agent.documentOperationServiceUnavailable')))
  return {
    list: unavailable,
    start: unavailable,
    get: unavailable,
    command: unavailable,
  }
}

export function desktopOperationBridge(): OperationBridge {
  const documents = window.nxcore?.documents
  return documents
    && typeof documents.listOperations === 'function'
    && typeof documents.startOperation === 'function'
    && typeof documents.getOperation === 'function'
    && typeof documents.executeOperationCommand === 'function'
    && typeof documents.onOperationChanged === 'function'
    ? createDesktopOperationBridge(documents)
    : unavailableOperationBridge()
}
