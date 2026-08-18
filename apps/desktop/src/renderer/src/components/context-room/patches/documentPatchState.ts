import type {
  DocumentEvent,
  DocumentPatch,
  DocumentPatchHunk,
  DocumentPatchStatus,
  DocumentPatchSummary,
  RoomDocument,
} from '@nxcore/agent-contract'

export type DocumentPatchHunkDecision = 'accepted' | 'rejected'
export type DocumentPatchDecisionMap = Record<string, DocumentPatchHunkDecision>

export interface DocumentPatchEventUpdate {
  patchId: string
  patch?: DocumentPatchSummary
  document?: RoomDocument
}

const patchEventTypes = new Set<DocumentEvent['type']>([
  'document.patch-building',
  'document.patch-prepared',
  'document.patch-continuation-advanced',
  'document.patch-applied',
  'document.patch-rejected',
  'document.patch-conflicted',
  'document.patch-aborted',
  'document.patch-expired',
])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function patchEventUpdate(event: DocumentEvent): DocumentPatchEventUpdate | null {
  if (!patchEventTypes.has(event.type)) return null
  const payload = record(event.payload)
  if (!payload) return null
  const patch = record(payload.patch) as Partial<DocumentPatchSummary> | null
  const patchId = typeof patch?.id === 'string'
    ? patch.id
    : typeof payload.patchId === 'string' ? payload.patchId : ''
  if (!patchId) return null
  const document = record(payload.document) as Partial<RoomDocument> | null
  return {
    patchId,
    ...(patch?.id === patchId ? { patch: patch as DocumentPatchSummary } : {}),
    ...(document?.id === event.documentId ? { document: document as RoomDocument } : {}),
  }
}

export function isPatchTerminal(status: DocumentPatchStatus): boolean {
  return status === 'applied'
    || status === 'rejected'
    || status === 'aborted'
    || status === 'expired'
}

export function decisionsForPatch(
  patch: DocumentPatch,
  current: DocumentPatchDecisionMap = {},
): DocumentPatchDecisionMap {
  const next: DocumentPatchDecisionMap = {}
  const accepted = new Set(patch.acceptedHunkIds)
  const rejected = new Set(patch.rejectedHunkIds)
  const authoritative = isPatchTerminal(patch.status)
  for (const hunk of patch.hunks) {
    if (accepted.has(hunk.id)) next[hunk.id] = 'accepted'
    else if (rejected.has(hunk.id)) next[hunk.id] = 'rejected'
    else if (!authoritative && current[hunk.id]) next[hunk.id] = current[hunk.id]
  }
  return next
}

export function setPatchHunkDecision(
  patch: Pick<DocumentPatch, 'hunks'>,
  current: DocumentPatchDecisionMap,
  hunkId: string,
  decision: DocumentPatchHunkDecision | null,
): DocumentPatchDecisionMap {
  if (!patch.hunks.some((hunk) => hunk.id === hunkId)) return current
  const next = { ...current }
  if (decision) next[hunkId] = decision
  else delete next[hunkId]
  return next
}

export function acceptedHunkIds(
  patch: Pick<DocumentPatch, 'hunks'>,
  decisions: DocumentPatchDecisionMap,
): string[] {
  return patch.hunks
    .filter((hunk) => decisions[hunk.id] === 'accepted')
    .map((hunk) => hunk.id)
}

export function patchDecisionCounts(
  patch: Pick<DocumentPatch, 'hunks'>,
  decisions: DocumentPatchDecisionMap,
): { accepted: number; rejected: number; undecided: number } {
  let accepted = 0
  let rejected = 0
  for (const hunk of patch.hunks) {
    if (decisions[hunk.id] === 'accepted') accepted += 1
    else if (decisions[hunk.id] === 'rejected') rejected += 1
  }
  return { accepted, rejected, undecided: patch.hunks.length - accepted - rejected }
}

export function adjacentPatchHunkId(
  hunks: DocumentPatchHunk[],
  currentHunkId: string | null,
  direction: -1 | 1,
): string | null {
  if (hunks.length === 0) return null
  const currentIndex = currentHunkId ? hunks.findIndex((hunk) => hunk.id === currentHunkId) : -1
  if (currentIndex < 0) return direction > 0 ? hunks[0].id : hunks[hunks.length - 1].id
  return hunks[(currentIndex + direction + hunks.length) % hunks.length].id
}
