import type { KnowledgeEntityDetailDto } from '../../../../../shared/knowledge'

interface KnowledgeEntityReader {
  getEntity(entityId: string): Promise<KnowledgeEntityDetailDto>
}

interface PromotionWaitOptions {
  attempts?: number
  intervalMs?: number
  signal?: AbortSignal
  wait?: (milliseconds: number) => Promise<void>
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, milliseconds)
})

export async function waitForKnowledgeEntityPromotion(
  knowledge: KnowledgeEntityReader,
  entityId: string,
  options: PromotionWaitOptions = {},
): Promise<KnowledgeEntityDetailDto | null> {
  const attempts = options.attempts ?? 60
  const intervalMs = options.intervalMs ?? 1_000
  const wait = options.wait ?? delay
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) return null
    try {
      const detail = await knowledge.getEntity(entityId)
      if (detail.room || detail.entity.roomId || detail.entity.status === 'room') return detail
    } catch {
      // The managed gateway can briefly restart while the promotion job is running.
    }
    if (attempt < attempts - 1) await wait(intervalMs)
  }
  return null
}
