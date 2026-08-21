/**
 * runtime config 的 knowledge.embedding → MemoryCore TDAI_EMBEDDING_* 环境变量。
 *
 * MemoryCore 约束(见 memory-core src/gateway/config.ts):env 下发完整远程配置
 * (PROVIDER/BASE_URL/API_KEY/MODEL/DIMENSIONS)时自动启用 embedding,缺任一项
 * 自动禁用不崩溃。provider 为任意非 local/none 字符串(OpenAI 兼容 HTTP)。
 * dimensions 由 gateway /v1/runtime-config/test 的真实 /embeddings 响应推导,
 * 不让用户手填。不设 TDAI_EMBEDDING_ENABLED/SEND_DIMENSIONS,走 MemoryCore 默认。
 */
export interface MemoryCoreEmbeddingFields {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

export function memoryCoreEmbeddingEnv(
  fields: MemoryCoreEmbeddingFields,
  dimensions: number,
): Record<string, string> {
  const provider = fields.provider.trim() || 'openai'
  return {
    TDAI_EMBEDDING_PROVIDER: provider,
    TDAI_EMBEDDING_BASE_URL: fields.baseUrl.trim(),
    TDAI_EMBEDDING_API_KEY: fields.apiKey.trim(),
    TDAI_EMBEDDING_MODEL: fields.model.trim(),
    TDAI_EMBEDDING_DIMENSIONS: String(dimensions),
  }
}

/** 从(未脱敏)runtime config snapshot 提取 knowledge.embedding 四要素;不齐全返回 null。 */
export function embeddingFieldsFromConfig(
  config: Record<string, unknown> | undefined | null,
): MemoryCoreEmbeddingFields | null {
  const knowledge = config?.knowledge
  const embedding = knowledge && typeof knowledge === 'object' && !Array.isArray(knowledge)
    ? (knowledge as Record<string, unknown>).embedding
    : undefined
  const value = embedding && typeof embedding === 'object' && !Array.isArray(embedding)
    ? embedding as Record<string, unknown>
    : {}
  const text = (key: string): string => {
    const raw = value[key]
    return typeof raw === 'string' ? raw.trim() : ''
  }
  const fields = {
    provider: text('provider'),
    model: text('model'),
    baseUrl: text('baseUrl'),
    apiKey: text('apiKey'),
  }
  if (!fields.model || !fields.baseUrl || !fields.apiKey) return null
  return fields
}
