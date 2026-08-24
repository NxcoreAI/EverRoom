/**
 * runtime config → 补全服务子进程（cursor-completion-serve）的 AI env。
 *
 * 补全服务是独立 gateway 进程（独立 dataDir/DB），没有 RuntimeConfigManager，
 * spawn env 是唯一配置通道。子进程 loadConfig 的 fallback 语义：
 * NXCORE_CURSOR_COMPLETION_AI_* 缺项回退 NXCORE_AI_*——因此两段都注入。
 * 不产空串值：子进程的 loadEnvFile 不覆盖已存在的 env 键，注入 "" 会把
 * 它自己的 .env fallback 打死（过渡期 .env 还有值时）。
 */

/** AI 段的可选透传键（camelCase → ENV 大写蛇形）。 */
const OPTIONAL_STRING_KEYS = ["api", "reasoning"] as const
const OPTIONAL_NUMBER_KEYS = ["maxTokens", "contextWindow", "temperature"] as const

/** camelCase → UPPER_SNAKE（api → API, maxTokens → MAX_TOKENS）。 */
function envKey(key: string): string {
  return key.replace(/([A-Z])/g, "_$1").toUpperCase()
}

function sectionEnv(
  section: Record<string, unknown> | undefined,
  prefix: string,
): Record<string, string> {
  if (!section || typeof section !== "object") return {}
  const text = (key: string): string => {
    const raw = section[key]
    return typeof raw === "string" ? raw.trim() : ""
  }
  // 四要素齐全才注入整套（半套会让子进程 boot 校验直接拒启）。
  if (!text("provider") || !text("model") || !text("baseUrl") || !text("apiKey")) return {}
  const env: Record<string, string> = {
    [`${prefix}PROVIDER`]: text("provider"),
    [`${prefix}MODEL`]: text("model"),
    [`${prefix}BASE_URL`]: text("baseUrl"),
    [`${prefix}API_KEY`]: text("apiKey"),
  }
  for (const key of OPTIONAL_STRING_KEYS) {
    if (text(key)) env[`${prefix}${envKey(key)}`] = text(key)
  }
  for (const key of OPTIONAL_NUMBER_KEYS) {
    const raw = section[key]
    if (typeof raw === "number" && Number.isFinite(raw)) env[`${prefix}${envKey(key)}`] = String(raw)
  }
  return env
}

/** runtime config cursorCompletion 段 + primary 段（兜底语义）→ 补全服务 AI env。 */
export function cursorCompletionEnvFromConfig(
  config: Record<string, unknown> | undefined | null,
): Record<string, string> {
  if (!config || typeof config !== "object") return {}
  return {
    ...sectionEnv(config.primary as Record<string, unknown> | undefined, "NXCORE_AI_"),
    ...sectionEnv(config.cursorCompletion as Record<string, unknown> | undefined, "NXCORE_CURSOR_COMPLETION_AI_"),
  }
}
