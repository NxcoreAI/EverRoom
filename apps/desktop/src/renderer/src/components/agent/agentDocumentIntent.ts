export interface AgentDocumentIntentResult {
  clarificationRequired: true
  originalPrompt: string
  topic: string
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value))
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function parseAgentDocumentIntentResult(result: unknown): AgentDocumentIntentResult | null {
  const root = record(result)
  if (!root) return null
  const contentResult = Array.isArray(root.content)
    ? root.content.map((item) => record(item)).find((item) => typeof item?.text === 'string')?.text
    : undefined
  const candidates = [root.details, root.structuredContent, root, contentResult]
  for (const value of candidates) {
    const candidate = record(value)
    if (candidate?.clarificationRequired !== true) continue
    const topic = typeof candidate.topic === 'string' ? candidate.topic.trim() : ''
    const originalPrompt = typeof candidate.originalPrompt === 'string'
      ? candidate.originalPrompt.trim()
      : ''
    if (topic && originalPrompt) return { clarificationRequired: true, originalPrompt, topic }
  }
  return null
}
