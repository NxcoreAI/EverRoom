import type { DocumentOperation, DocumentOperationSummary } from '@nxcore/agent-contract'
import type { DocumentOperationDecisionMap, DocumentOperationEntry } from './types'

export type DocumentOperationStoreState = Record<string, DocumentOperationEntry>

export function mergeOperationSummary(
  current: DocumentOperationEntry | undefined,
  summary: DocumentOperationSummary,
): DocumentOperationEntry {
  return {
    id: summary.id,
    summary,
    detail: current?.detail ?? null,
    decisions: current?.decisions ?? {},
    busy: current?.busy ?? false,
    error: current?.error,
    revision: summary.revision,
  }
}

export function mergeOperationDetail(
  current: DocumentOperationEntry | undefined,
  detail: DocumentOperation,
): DocumentOperationEntry {
  const summary = detail
  const validIds = new Set(detail.items.map((item) => item.id))
  const decisions = Object.fromEntries(
    Object.entries(current?.decisions ?? {}).filter(([itemId]) => validIds.has(itemId)),
  ) as DocumentOperationDecisionMap
  return {
    id: summary.id,
    summary,
    detail,
    decisions,
    busy: current?.busy ?? false,
    error: current?.error,
    revision: summary.revision,
  }
}

export function setOperationDecision(
  entry: DocumentOperationEntry,
  itemId: string,
  decision: DocumentOperationDecisionMap[string] | null,
): DocumentOperationEntry {
  const decisions = { ...entry.decisions }
  if (decision) decisions[itemId] = decision
  else delete decisions[itemId]
  return { ...entry, decisions }
}
