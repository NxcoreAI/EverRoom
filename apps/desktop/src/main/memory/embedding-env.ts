/**
 * runtime config 的 knowledge.embedding → MemoryCore TDAI_EMBEDDING_* 环境变量。
 *
 * 两条来源：
 * - relay 槽位（baseUrl 指向 gateway /ai-relay）：API_KEY 换成 gateway 生命周期
 *   稳定的 bearer token，dimensions 用静态表——SaaS 中转 token 25min 轮换完全
 *   留在 gateway 进程内，MemoryCore env 恒定不因轮换重启；
 * - BYOK（用户自配直连）：原样透传，维度经 /v1/runtime-config/test 真实探测。
 *
 * MemoryCore 约束(见 memory-core src/gateway/config.ts):env 下发完整远程配置
 * (PROVIDER/BASE_URL/API_KEY/MODEL/DIMENSIONS)时自动启用 embedding,缺任一项
 * 自动禁用不崩溃(降级为 FTS/metadata-only,配合 store 补丁不再变砖)。provider
 * 为任意非 local/none 字符串(OpenAI 兼容 HTTP)。
 * 脱敏占位（********）等同缺失：不注入掩码（MemoryCore 会当真 key 用，
 * 每个上游请求静默 401），宁可不注入让它按未配置降级。
 */

import { isMaskedRuntimeConfigSecret } from '../../shared/sources'
export interface MemoryCoreEmbeddingFields {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

/** gateway /ai-relay 槽位的稳定凭据：gateway 生命周期内不变（区别于 25min 轮换的 SaaS 中转 token）。 */
export interface GatewayRelayConnection {
  baseUrl: string
  token: string
}

/** relay 走 newapi 的 embedding 模型 → 向量维度静态表（新模型接入时补一行）。 */
const RELAY_EMBEDDING_DIMENSIONS: Record<string, number> = {
  'text-embedding-v4': 1536,
}

export function relayEmbeddingDimensions(model: string): number {
  return RELAY_EMBEDDING_DIMENSIONS[model.trim()] ?? 1536
}

/** 槽位 baseUrl 是否指向本 app gateway 的 /ai-relay（= 经 SaaS newapi 中转）。 */
export function isRelaySlotUrl(url: string, relay: GatewayRelayConnection | null): boolean {
  if (!relay) return false
  return url.trim().startsWith(`${relay.baseUrl.replace(/\/+$/, '')}/ai-relay`)
}

/** TDAI_* env 中指向 /ai-relay 的 BASE_URL，其 API_KEY 统一替换为稳定的 gateway token。 */
export function withStableRelayKey(
  env: Record<string, string> | null,
  relay: GatewayRelayConnection | null,
): Record<string, string> | null {
  if (!relay || !env) return env
  let stabilized = env
  if (isRelaySlotUrl(env.TDAI_EMBEDDING_BASE_URL ?? '', relay)) {
    stabilized = { ...stabilized, TDAI_EMBEDDING_API_KEY: relay.token }
  }
  if (isRelaySlotUrl(env.TDAI_LLM_BASE_URL ?? '', relay)) {
    stabilized = { ...stabilized, TDAI_LLM_API_KEY: relay.token }
  }
  return stabilized
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
    return typeof raw === 'string' && !isMaskedRuntimeConfigSecret(raw) ? raw.trim() : ''
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

/**
 * runtime config primary 段 → MemoryCore TDAI_LLM_*(提炼管道主 LLM)。
 * baseUrl/apiKey/model 三项全非空才算已配置;未配置返回 null(保持 .env 透传/
 * MemoryCore 默认)。provider/maxTokens 等不在 MemoryCore 的 TDAI_LLM 表面内。
 */
export function memoryCoreLlmEnv(
  config: Record<string, unknown> | undefined | null,
): Record<string, string> | null {
  const primary = config?.primary
  const value = primary && typeof primary === 'object' && !Array.isArray(primary)
    ? primary as Record<string, unknown>
    : {}
  const text = (key: string): string => {
    const raw = value[key]
    return typeof raw === 'string' && !isMaskedRuntimeConfigSecret(raw) ? raw.trim() : ''
  }
  const baseUrl = text('baseUrl')
  const apiKey = text('apiKey')
  const model = text('model')
  if (!baseUrl || !apiKey || !model) return null
  return {
    TDAI_LLM_BASE_URL: baseUrl,
    TDAI_LLM_API_KEY: apiKey,
    TDAI_LLM_MODEL: model,
  }
}

/**
 * MemoryCore 子进程的 AI 覆盖 env(LLM + embedding 合并);两者皆未配置返回
 * null(= 不覆盖,恢复 .env 透传)。调用方经 JSON 比较决定是否 restart。
 */
export function memoryCoreEnvironment(
  config: Record<string, unknown> | undefined | null,
  embeddingEnv: Record<string, string> | null,
): Record<string, string> | null {
  const llmEnv = memoryCoreLlmEnv(config)
  if (llmEnv && embeddingEnv) return { ...llmEnv, ...embeddingEnv }
  return llmEnv ?? embeddingEnv
}
