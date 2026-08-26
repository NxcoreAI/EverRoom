/**
 * runtime config primary 段 → Knowledge Service（Wiki 引擎）LLM_* 环境变量。
 *
 * KS 子进程没有 RuntimeConfigManager，spawn env 是唯一配置通道
 * （knowledge-supervisor llmEnvironment 已把 NXCORE_AI_* 映射为 LLM_*；
 * .env 清空迁移 runtime config 后那段映射失效，本模块补 runtime 侧来源）。
 * KS config.ts 的 LLM 表面：LLM_MODE/PROTOCOL/PROVIDER/API_KEY/MODEL/
 * BASE_URL/MAX_TOKENS。三项（baseUrl/apiKey/model）全非空才算已配置，
 * 未配置返回 null（保持 .env 透传，不注入半套——LLM_MODE=custom 无 key
 * 会让 wiki ingest 直接报"LLM apiKey 未配置"）。
 */

/** runtime config primary 段 → KS LLM_*（custom 直连模式）；未配置返回 null。 */
export function knowledgeServiceLlmEnv(
  config: Record<string, unknown> | undefined | null,
): Record<string, string> | null {
  const primary = config?.primary
  const value = primary && typeof primary === 'object' && !Array.isArray(primary)
    ? primary as Record<string, unknown>
    : {}
  const text = (key: string): string => {
    const raw = value[key]
    return typeof raw === 'string' ? raw.trim() : ''
  }
  const baseUrl = text('baseUrl')
  const apiKey = text('apiKey')
  const model = text('model')
  if (!baseUrl || !apiKey || !model) return null
  return {
    LLM_MODE: 'custom',
    LLM_BASE_URL: baseUrl,
    LLM_API_KEY: apiKey,
    LLM_MODEL: model,
  }
}
