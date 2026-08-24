/**
 * runtime config 有效性判定与连通测试（启动 gate 用）：
 * - configured：primary 四要素（provider/model/baseUrl/apiKey）非空即视为已配置，
 *   只看"填没填"，不发网络请求——gate 首屏判定要快；
 * - testConnection：对生效配置的真实 LLM 端点发一次 max_tokens=1 的 chat
 *   completion，验证 baseUrl/apiKey/model 真的能用（"配置成功后测试 config
 *   是有效的才放行"）。
 */

export interface AiConfigFields {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

const AI_REQUIRED_FIELDS = ["provider", "model", "baseUrl", "apiKey"] as const;

/** 从 runtime config 的 primary 段提取 AI 四要素（空串/缺项归一为 ""）。 */
export function primaryAiFields(config: Record<string, unknown>): AiConfigFields {
  const primary = config.primary;
  const value = primary && typeof primary === "object" && !Array.isArray(primary)
    ? primary as Record<string, unknown>
    : {};
  const text = (key: string): string => {
    const raw = value[key];
    return typeof raw === "string" ? raw.trim() : "";
  };
  return {
    provider: text("provider"),
    model: text("model"),
    baseUrl: text("baseUrl"),
    apiKey: text("apiKey"),
  };
}

/** 已配置判定：四要素全部非空（占位空串视为未配置）。 */
export function isPrimaryConfigured(config: Record<string, unknown>): boolean {
  return aiFieldsConfigured(primaryAiFields(config));
}

/** 四要素全部非空 = 该段已配置（primary/embedding/vlm 共用）。 */
export function aiFieldsConfigured(fields: AiConfigFields): boolean {
  return AI_REQUIRED_FIELDS.every((field) => fields[field] !== "");
}

/** 从 config 任意 AI 段（primary/vlm/…）提取四要素（缺段/空串归一为 ""）。 */
function sectionAiFields(config: Record<string, unknown>, section: string): AiConfigFields {
  const value = config[section] && typeof config[section] === "object" && !Array.isArray(config[section])
    ? config[section] as Record<string, unknown>
    : {};
  const text = (key: string): string => {
    const raw = value[key];
    return typeof raw === "string" ? raw.trim() : "";
  };
  return {
    provider: text("provider"),
    model: text("model"),
    baseUrl: text("baseUrl"),
    apiKey: text("apiKey"),
  };
}

/** 从 runtime config 的 knowledge.embedding 段提取四要素（缺段/空串归一为 ""）。 */
export function embeddingAiFields(config: Record<string, unknown>): AiConfigFields {
  const knowledge = config.knowledge;
  const embedding = knowledge && typeof knowledge === "object" && !Array.isArray(knowledge)
    ? (knowledge as Record<string, unknown>).embedding
    : undefined;
  return embedding && typeof embedding === "object" && !Array.isArray(embedding)
    ? sectionAiFields({ section: embedding }, "section")
    : { provider: "", model: "", baseUrl: "", apiKey: "" };
}

/** 从 runtime config 的 vlm 段提取四要素（缺段/空串归一为 ""）。 */
export function vlmAiFields(config: Record<string, unknown>): AiConfigFields {
  return sectionAiFields(config, "vlm");
}

/** embedding 已配置判定：四要素全部非空（未填/部分填都视为未配置，不参与测试）。 */
export function isEmbeddingConfigured(fields: AiConfigFields): boolean {
  return aiFieldsConfigured(fields);
}

export interface TestConnectionResult {
  valid: boolean;
  /** 失败时的可展示原因（HTTP 状态/网络错误/超时）。 */
  error?: string;
}

export interface EmbeddingTestResult extends TestConnectionResult {
  /** 成功时返回的向量维度（MemoryCore TDAI_EMBEDDING_DIMENSIONS 注入用）。 */
  dimensions?: number;
}

const TEST_TIMEOUT_MS = 15_000;

/**
 * 连通测试：POST {baseUrl}/chat/completions，max_tokens=1。
 * 任意 2xx 即视为有效（内容不要求可用——只验证端点+凭据+模型名被接受）。
 * 401/403 → 凭据问题；404 → baseUrl 不对；其他非 2xx 带上服务端 message。
 */
export async function testAiConnection(fields: AiConfigFields): Promise<TestConnectionResult> {
  if (!isPrimaryConfigured({ primary: fields })) {
    return { valid: false, error: "runtime_config_test_incomplete" };
  }
  let response: Response;
  try {
    response = await fetch(`${fields.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fields.apiKey}`,
      },
      body: JSON.stringify({
        model: fields.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return { valid: false, error: `runtime_config_test_unreachable: ${cause.slice(0, 200)}` };
  }
  if (response.ok) return { valid: true };
  const detail = await response.text().catch(() => "");
  let message = "";
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string }; message?: string };
    message = parsed.error?.message ?? parsed.message ?? "";
  } catch {
    // 非 JSON 响应体，退回原文
  }
  return {
    valid: false,
    error: `runtime_config_test_http_${response.status}: ${(message || detail).slice(0, 200)}`,
  };
}

/**
 * embedding 连通测试：POST {baseUrl}/embeddings，input="ping"。
 * 2xx 且 data[0].embedding 为非空数组才算有效，同时返回向量维度——
 * MemoryCore 的 TDAI_EMBEDDING_DIMENSIONS 是必填项，用真实响应推导
 * 比让用户手填维度可靠。错误串复用 primary 的 taxonomy，渲染层
 * configTestErrorMessage 无需新增映射。
 */
export async function testEmbeddingConnection(fields: AiConfigFields): Promise<EmbeddingTestResult> {
  if (!isEmbeddingConfigured(fields)) {
    return { valid: false, error: "runtime_config_test_incomplete" };
  }
  let response: Response;
  try {
    response = await fetch(`${fields.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fields.apiKey}`,
      },
      body: JSON.stringify({ model: fields.model, input: "ping" }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return { valid: false, error: `runtime_config_test_unreachable: ${cause.slice(0, 200)}` };
  }
  if (response.ok) {
    const payload = await response.json().catch(() => null) as {
      data?: Array<{ embedding?: number[] }>;
    } | null;
    const vector = payload?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      return { valid: false, error: "runtime_config_test_invalid_response: missing data[0].embedding" };
    }
    return { valid: true, dimensions: vector.length };
  }
  const detail = await response.text().catch(() => "");
  let message = "";
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string }; message?: string };
    message = parsed.error?.message ?? parsed.message ?? "";
  } catch {
    // 非 JSON 响应体，退回原文
  }
  return {
    valid: false,
    error: `runtime_config_test_http_${response.status}: ${(message || detail).slice(0, 200)}`,
  };
}
