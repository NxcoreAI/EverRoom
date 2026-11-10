import type {
  DocumentBlockReferenceInput,
  DocumentBlockResolution,
  ResolveDocumentBlockReferencesInput,
  ResolveDocumentBlockReferencesResult,
} from '@nxcore/agent-contract'

export type DocumentBlockReferenceResolver = (
  input: ResolveDocumentBlockReferencesInput,
) => Promise<ResolveDocumentBlockReferencesResult>

interface PendingReferenceResolution {
  reference: DocumentBlockReferenceInput
  resolve: (resolution: DocumentBlockResolution | null) => void
  reject: (error: unknown) => void
}

const REFERENCE_RESOLUTION_BATCH_LIMIT = 200
const pendingReferenceResolutions = new WeakMap<
  DocumentBlockReferenceResolver,
  Map<string, PendingReferenceResolution[]>
>()

async function flushReferenceResolutionBatch(
  resolver: DocumentBlockReferenceResolver,
  sourceRoomId: string,
  pending: PendingReferenceResolution[],
): Promise<void> {
  for (let offset = 0; offset < pending.length; offset += REFERENCE_RESOLUTION_BATCH_LIMIT) {
    const chunk = pending.slice(offset, offset + REFERENCE_RESOLUTION_BATCH_LIMIT)
    try {
      const result = await resolver({
        sourceRoomId,
        references: chunk.map((item) => item.reference),
      })
      chunk.forEach((item, index) => item.resolve(result.resolutions[index] ?? null))
    } catch (error) {
      chunk.forEach((item) => item.reject(error))
    }
  }
}

export function resolveDocumentBlockReference(
  resolver: DocumentBlockReferenceResolver,
  sourceRoomId: string,
  reference: DocumentBlockReferenceInput,
): Promise<DocumentBlockResolution | null> {
  let batches = pendingReferenceResolutions.get(resolver)
  if (!batches) {
    batches = new Map()
    pendingReferenceResolutions.set(resolver, batches)
  }
  let pending = batches.get(sourceRoomId)
  if (!pending) {
    pending = []
    batches.set(sourceRoomId, pending)
    queueMicrotask(() => {
      const batch = batches?.get(sourceRoomId) ?? []
      batches?.delete(sourceRoomId)
      if (batches?.size === 0) pendingReferenceResolutions.delete(resolver)
      void flushReferenceResolutionBatch(resolver, sourceRoomId, batch)
    })
  }
  return new Promise((resolve, reject) => {
    pending.push({ reference, resolve, reject })
  })
}
