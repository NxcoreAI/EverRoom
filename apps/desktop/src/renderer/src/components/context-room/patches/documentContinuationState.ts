import type { DocumentContinuationBlock, DocumentPatch } from '@nxcore/agent-contract'

export function pendingContinuationBlock(
  patch: Pick<DocumentPatch, 'kind' | 'status' | 'nextPendingBlock'> | null | undefined,
): DocumentContinuationBlock | null {
  return patch?.kind === 'continue' && patch.status === 'pending'
    ? patch.nextPendingBlock
    : null
}

export function pendingContinuationBlocks(
  patch: Pick<
    DocumentPatch,
    'kind' | 'status' | 'continuationBlocks' | 'acceptedBlockIds' | 'rejectedBlockIds'
  > | null | undefined,
): DocumentContinuationBlock[] {
  if (patch?.kind !== 'continue' || patch.status !== 'pending') return []
  const decided = new Set([...patch.acceptedBlockIds, ...patch.rejectedBlockIds])
  return patch.continuationBlocks
    .filter((block) => !decided.has(block.blockId))
    .sort((left, right) => left.sequence - right.sequence)
}

export function continuationBaseVersion(
  patch: Pick<DocumentPatch, 'baseVersion' | 'appliedVersion'>,
): number {
  return patch.appliedVersion ?? patch.baseVersion
}

export function shouldHandleContinuationTab(input: {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  candidateVisible: boolean
  busy: boolean
}): boolean {
  return input.key === 'Tab'
    && !input.altKey
    && !input.ctrlKey
    && !input.metaKey
    && !input.shiftKey
    && input.candidateVisible
    && !input.busy
}
