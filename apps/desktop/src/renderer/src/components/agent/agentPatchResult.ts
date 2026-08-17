export interface AgentPatchToolResult {
  patchId: string
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

export function parseAgentPatchToolResult(result: unknown): AgentPatchToolResult | null {
  const root = record(result)
  if (!root) return null
  const contentResult = Array.isArray(root.content)
    ? root.content.map((item) => record(item)).find((item) => typeof item?.text === 'string')?.text
    : undefined
  for (const value of [root.details, root.structuredContent, root, contentResult]) {
    const candidate = record(value)
    const nestedPatch = record(candidate?.patch)
    const patchId = typeof candidate?.patchId === 'string'
      ? candidate.patchId.trim()
      : typeof nestedPatch?.id === 'string' ? nestedPatch.id.trim() : ''
    if (patchId) return { patchId }
  }
  return null
}
