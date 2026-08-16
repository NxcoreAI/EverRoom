import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { KnowledgeRuntimeConfig, MemoryRuntimeConfig } from "@nxcore/agent-runtime-pi";

const LogLevelSchema = Type.Union([
  Type.Literal("fatal"),
  Type.Literal("error"),
  Type.Literal("warn"),
  Type.Literal("info"),
  Type.Literal("debug"),
  Type.Literal("trace"),
  Type.Literal("silent"),
]);

const AgentRuntimeSchema = Type.Union([
  Type.Literal("fake"),
  Type.Literal("pi"),
  Type.Literal("remote-http"),
]);
const AsrProviderSchema = Type.Union([Type.Literal("disabled"), Type.Literal("aliyun")]);
const AiApiSchema = Type.Union([
  Type.Literal("openai-completions"),
  Type.Literal("openai-responses"),
  Type.Literal("anthropic-messages"),
  Type.Literal("google-generative-ai"),
]);
const AiReasoningSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const RawConfigSchema = Type.Object(
  {
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 0, maximum: 65535 }),
    dataDir: Type.String({ minLength: 1 }),
    logLevel: LogLevelSchema,
    authToken: Type.String({ minLength: 16 }),
    agentRuntime: AgentRuntimeSchema,
    remoteAgentBaseUrl: Type.String({ minLength: 1 }),
    remoteAgentToken: Type.String(),
    remoteAgentMcpWebSocketUrl: Type.String(),
    aiProvider: Type.String(),
    aiModel: Type.String(),
    aiBaseUrl: Type.String(),
    aiApiKey: Type.String(),
    aiApi: AiApiSchema,
    aiMaxTokens: Type.Integer({ minimum: 1 }),
    aiContextWindow: Type.Integer({ minimum: 1 }),
    aiTemperature: Type.Number({ minimum: 0, maximum: 2 }),
    aiReasoning: AiReasoningSchema,
    asrProvider: AsrProviderSchema,
    asrAliyunApiKey: Type.String(),
    asrAliyunBaseUrl: Type.String(),
    asrAliyunModel: Type.String({ minLength: 1 }),
    asrAliyunOssRegion: Type.String(),
    asrAliyunOssBucket: Type.String(),
    asrAliyunOssAccessKeyId: Type.String(),
    asrAliyunOssAccessKeySecret: Type.String(),
    asrAliyunOssStsToken: Type.String(),
    asrAliyunOssPrefix: Type.String({ minLength: 1 }),
    memoryEnabled: Type.Boolean(),
    memoryBaseUrl: Type.String(),
    memoryApiKey: Type.String(),
    memoryServiceId: Type.String({ minLength: 1 }),
    memoryTeamId: Type.String({ minLength: 1 }),
    memoryAgentId: Type.String({ minLength: 1 }),
    memoryUserId: Type.String({ minLength: 1 }),
    memoryRecallLimit: Type.Integer({ minimum: 1, maximum: 50 }),
    memoryCharBudget: Type.Integer({ minimum: 200 }),
    knowledgeEnabled: Type.Boolean(),
    knowledgeBaseUrl: Type.String(),
    knowledgeServiceId: Type.String({ minLength: 1 }),
    knowledgeTeamId: Type.String({ minLength: 1 }),
    knowledgeWikiId: Type.String(),
    knowledgeRoomWikisEnabled: Type.Boolean(),
    knowledgeIngestDebounceMs: Type.Integer({ minimum: 0 }),
    knowledgeRouterEnabled: Type.Boolean(),
    knowledgeRouteThresholdAuto: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    knowledgeRouteThresholdReview: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    knowledgeAutoCreateRoomEnabled: Type.Boolean(),
    knowledgeLlmBaseUrl: Type.String(),
    knowledgeLlmApiKey: Type.String(),
    knowledgeLlmModel: Type.String(),
    knowledgeEmbeddingModel: Type.String(),
  },
  { additionalProperties: false },
);

export type LogLevel = typeof LogLevelSchema.static;
export type AgentRuntimeMode = typeof AgentRuntimeSchema.static;
export type AiApi = typeof AiApiSchema.static;
export type AiReasoning = typeof AiReasoningSchema.static;

export interface AliyunAsrConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  oss: AliyunOssConfig | null;
}

export interface AliyunOssConfig {
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  stsToken?: string;
  prefix: string;
}

export interface PiRuntimeConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  api: AiApi;
  maxTokens: number;
  contextWindow: number;
  temperature: number;
  reasoning: AiReasoning;
  sessionsDir: string;
  workingDirectory: string;
  agentDirectory: string;
  memory?: MemoryRuntimeConfig;
  knowledge?: KnowledgeRuntimeConfig;
}

/** gateway 侧 knowledge 模块配置（Room wiki 注册表 + ingest worker，docs/room-wiki-plan.md §7.1）。 */
export interface KnowledgeGatewayConfig {
  baseUrl: string;
  serviceId: string;
  teamId: string;
  /** Room 级 wiki 总开关；关闭时本模块不接管任何文档事件。 */
  roomWikisEnabled: boolean;
  /** 文档落定后的入队防抖窗口（毫秒）。 */
  ingestDebounceMs: number;
  /** 自动归类路由总开关（②③④⑤ 瀑布）；关闭时仅 ① 入口直连 ingest。 */
  routerEnabled: boolean;
  /** ⑤ 输出 confidence ≥ 此值自动执行（含 create_new，后者另受 autoCreateRoomEnabled 门控）。 */
  routeThresholdAuto: number;
  /** ⑤ 输出 confidence < 此值进待归类队列。 */
  routeThresholdReview: number;
  /** ⑤ 判 create_new 时是否自动建 Room（独立灰度；关闭则降级为待归类建议）。 */
  autoCreateRoomEnabled: boolean;
  /** ⑤ 仲裁与摘要抽取用的 LLM；缺省回退 NXCORE_AI_*。 */
  llm: KnowledgeLlmConfig | null;
  /** ④ 向量层的 embedding 端点（与 ⑤ 同源配置；⑤ 关闭时 ④ 仍可独立开启）。 */
  embeddingLlm: KnowledgeLlmConfig | null;
  /** ④ 向量层 embedding 模型；空 = 关闭向量候选层。 */
  embeddingModel: string;
}

export interface KnowledgeLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface GatewayConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  migrationsDir: string;
  runtimeManifestPath: string;
  logLevel: LogLevel;
  authToken: string;
  agentRuntime: AgentRuntimeMode;
  remoteAgent: {
    baseUrl: string;
    token: string | null;
    mcpWebSocketUrl: string | null;
  } | null;
  pi: PiRuntimeConfig | null;
  knowledge: KnowledgeGatewayConfig | null;
  asrInputDir: string;
  asr: AliyunAsrConfig | null;
}

function defaultDataDir(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "NxCore");
    case "win32":
      return join(process.env.LOCALAPPDATA ?? homedir(), "NxCore");
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "nxcore");
  }
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid gateway port: ${value}`);
  }

  return Number(value);
}

function parsePositiveInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return Number(value);
}

/** 防抖窗口等 legitimately 允许 0（=立即执行）的整数配置用这个。 */
function parseNonNegativeInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return Number(value);
}

function parseTemperature(value: string): number {
  const temperature = Number(value);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error(`Invalid NXCORE_AI_TEMPERATURE: ${value}`);
  }
  return temperature;
}

function parseFraction(name: string, value: string): number {
  const fraction = Number(value);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error(`Invalid ${name}: expected a fraction in (0, 1]`);
  }
  return fraction;
}

function validateAiEndpoint(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid NXCORE_AI_BASE_URL: expected an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid NXCORE_AI_BASE_URL: expected an absolute HTTP(S) URL");
  }
}

function validateHttpEndpoint(name: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: expected an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Invalid ${name}: expected an absolute HTTPS URL`);
  }
}

/** MemoryCore 通常是本地/内网 HTTP 服务：允许 localhost/127.0.0.1 的 HTTP 与任意 HTTPS。 */
function validateMemoryEndpoint(name: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: expected an absolute HTTP(S) URL`);
  }
  const isLoopbackHttp = url.protocol === "http:"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1");
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    throw new Error(`Invalid ${name}: plain HTTP is only allowed for loopback addresses`);
  }
}

function parseBoolean(name: string, value: string): boolean {
  if (value !== "true" && value !== "false") {
    throw new Error(`Invalid ${name}: expected "true" or "false"`);
  }
  return value === "true";
}

function inferMcpWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/device-mcp`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function defaultMigrationsDir(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, "drizzle"),
    resolve(moduleDirectory, "..", "drizzle"),
    resolve("drizzle"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const { values } = parseArgs({
    args: normalizedArgv,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      "data-dir": { type: "string" },
      "log-level": { type: "string" },
      token: { type: "string" },
      "migrations-dir": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const dataDir = resolve(values["data-dir"] ?? env.NXCORE_GATEWAY_DATA_DIR ?? defaultDataDir());
  const remoteAgentBaseUrl = env.NXCORE_REMOTE_AGENT_BASE_URL?.trim()
    ?? "http://192.168.1.27:8280/ai/api";
  const rawConfig = {
    host: values.host ?? env.NXCORE_GATEWAY_HOST ?? "127.0.0.1",
    port: parsePort(values.port ?? env.NXCORE_GATEWAY_PORT ?? "0"),
    dataDir,
    logLevel: values["log-level"] ?? env.NXCORE_GATEWAY_LOG_LEVEL ?? "info",
    authToken: values.token ?? env.NXCORE_GATEWAY_TOKEN ?? randomBytes(32).toString("base64url"),
    agentRuntime: env.NXCORE_AGENT_RUNTIME ?? "remote-http",
    remoteAgentBaseUrl,
    remoteAgentToken: env.NXCORE_REMOTE_AGENT_TOKEN?.trim() ?? "",
    remoteAgentMcpWebSocketUrl: env.NXCORE_REMOTE_AGENT_MCP_WS_URL?.trim()
      ?? inferMcpWebSocketUrl(remoteAgentBaseUrl),
    aiProvider: env.NXCORE_AI_PROVIDER?.trim() ?? "",
    aiModel: env.NXCORE_AI_MODEL?.trim() ?? "",
    aiBaseUrl: env.NXCORE_AI_BASE_URL?.trim() ?? "",
    aiApiKey: env.NXCORE_AI_API_KEY?.trim() ?? "",
    aiApi: env.NXCORE_AI_API ?? "openai-completions",
    aiMaxTokens: parsePositiveInteger("NXCORE_AI_MAX_TOKENS", env.NXCORE_AI_MAX_TOKENS ?? "8192"),
    aiContextWindow: parsePositiveInteger(
      "NXCORE_AI_CONTEXT_WINDOW",
      env.NXCORE_AI_CONTEXT_WINDOW ?? "128000",
    ),
    aiTemperature: parseTemperature(env.NXCORE_AI_TEMPERATURE ?? "0.3"),
    aiReasoning: env.NXCORE_AI_REASONING ?? "medium",
    asrProvider: env.NXCORE_ASR_PROVIDER ?? "disabled",
    asrAliyunApiKey: env.NXCORE_ASR_ALIYUN_API_KEY?.trim() ?? "",
    asrAliyunBaseUrl: env.NXCORE_ASR_ALIYUN_BASE_URL?.trim()
      ?? "https://dashscope.aliyuncs.com/api/v1",
    asrAliyunModel: env.NXCORE_ASR_ALIYUN_MODEL?.trim()
      ?? "qwen-audio-3.0-asr-flash-filetrans",
    asrAliyunOssRegion: env.NXCORE_ASR_ALIYUN_OSS_REGION?.trim() ?? "",
    asrAliyunOssBucket: env.NXCORE_ASR_ALIYUN_OSS_BUCKET?.trim() ?? "",
    asrAliyunOssAccessKeyId: env.NXCORE_ASR_ALIYUN_OSS_ACCESS_KEY_ID?.trim() ?? "",
    asrAliyunOssAccessKeySecret: env.NXCORE_ASR_ALIYUN_OSS_ACCESS_KEY_SECRET?.trim() ?? "",
    asrAliyunOssStsToken: env.NXCORE_ASR_ALIYUN_OSS_STS_TOKEN?.trim() ?? "",
    asrAliyunOssPrefix: env.NXCORE_ASR_ALIYUN_OSS_PREFIX?.trim() ?? "nxcore-asr",
    memoryEnabled: env.NXCORE_MEMORY_ENABLED == null
      ? false
      : parseBoolean("NXCORE_MEMORY_ENABLED", env.NXCORE_MEMORY_ENABLED.trim()),
    memoryBaseUrl: env.NXCORE_MEMORY_BASE_URL?.trim() ?? "http://127.0.0.1:8420",
    memoryApiKey: env.NXCORE_MEMORY_API_KEY?.trim() ?? "",
    memoryServiceId: env.NXCORE_MEMORY_SERVICE_ID?.trim() ?? "everroom",
    memoryTeamId: env.NXCORE_MEMORY_TEAM_ID?.trim() ?? "everroom",
    memoryAgentId: env.NXCORE_MEMORY_AGENT_ID?.trim() ?? "pi-agent",
    memoryUserId: env.NXCORE_MEMORY_USER_ID?.trim() ?? "local-user",
    memoryRecallLimit: parsePositiveInteger(
      "NXCORE_MEMORY_RECALL_LIMIT",
      env.NXCORE_MEMORY_RECALL_LIMIT ?? "5",
    ),
    memoryCharBudget: parsePositiveInteger(
      "NXCORE_MEMORY_CHAR_BUDGET",
      env.NXCORE_MEMORY_CHAR_BUDGET ?? "2000",
    ),
    knowledgeEnabled: env.NXCORE_KNOWLEDGE_ENABLED == null
      ? false
      : parseBoolean("NXCORE_KNOWLEDGE_ENABLED", env.NXCORE_KNOWLEDGE_ENABLED.trim()),
    knowledgeBaseUrl: env.NXCORE_KNOWLEDGE_BASE_URL?.trim() ?? "http://127.0.0.1:8421",
    knowledgeServiceId: env.NXCORE_KNOWLEDGE_SERVICE_ID?.trim() ?? "everroom",
    knowledgeTeamId: env.NXCORE_KNOWLEDGE_TEAM_ID?.trim() ?? "everroom",
    knowledgeWikiId: env.NXCORE_KNOWLEDGE_WIKI_ID?.trim() ?? "",
    knowledgeRoomWikisEnabled: env.NXCORE_KNOWLEDGE_ROOM_WIKIS_ENABLED == null
      ? false
      : parseBoolean(
          "NXCORE_KNOWLEDGE_ROOM_WIKIS_ENABLED",
          env.NXCORE_KNOWLEDGE_ROOM_WIKIS_ENABLED.trim(),
        ),
    knowledgeIngestDebounceMs: parseNonNegativeInteger(
      "NXCORE_KNOWLEDGE_INGEST_DEBOUNCE_MS",
      env.NXCORE_KNOWLEDGE_INGEST_DEBOUNCE_MS ?? "600000",
    ),
    knowledgeRouterEnabled: env.NXCORE_KNOWLEDGE_ROUTER_ENABLED == null
      ? false
      : parseBoolean("NXCORE_KNOWLEDGE_ROUTER_ENABLED", env.NXCORE_KNOWLEDGE_ROUTER_ENABLED.trim()),
    knowledgeRouteThresholdAuto: parseFraction(
      "NXCORE_KNOWLEDGE_ROUTE_THRESHOLD_AUTO",
      env.NXCORE_KNOWLEDGE_ROUTE_THRESHOLD_AUTO ?? "0.8",
    ),
    knowledgeRouteThresholdReview: parseFraction(
      "NXCORE_KNOWLEDGE_ROUTE_THRESHOLD_REVIEW",
      env.NXCORE_KNOWLEDGE_ROUTE_THRESHOLD_REVIEW ?? "0.6",
    ),
    knowledgeAutoCreateRoomEnabled: env.NXCORE_KNOWLEDGE_AUTO_CREATE_ROOM_ENABLED == null
      ? false
      : parseBoolean(
          "NXCORE_KNOWLEDGE_AUTO_CREATE_ROOM_ENABLED",
          env.NXCORE_KNOWLEDGE_AUTO_CREATE_ROOM_ENABLED.trim(),
        ),
    knowledgeLlmBaseUrl: env.NXCORE_KNOWLEDGE_LLM_BASE_URL?.trim() ?? "",
    knowledgeLlmApiKey: env.NXCORE_KNOWLEDGE_LLM_API_KEY?.trim() ?? "",
    knowledgeLlmModel: env.NXCORE_KNOWLEDGE_LLM_MODEL?.trim() ?? "",
    knowledgeEmbeddingModel: env.NXCORE_KNOWLEDGE_EMBEDDING_MODEL?.trim() ?? "",
  };

  if (!Value.Check(RawConfigSchema, rawConfig)) {
    const details = [...Value.Errors(RawConfigSchema, rawConfig)]
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join("; ");
    throw new Error(`Invalid gateway configuration: ${details}`);
  }

  if (rawConfig.agentRuntime === "pi") {
    const missing = [
      ["NXCORE_AI_PROVIDER", rawConfig.aiProvider],
      ["NXCORE_AI_MODEL", rawConfig.aiModel],
      ["NXCORE_AI_BASE_URL", rawConfig.aiBaseUrl],
      ["NXCORE_AI_API_KEY", rawConfig.aiApiKey],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`Pi runtime requires: ${missing.join(", ")}`);
    }
    validateAiEndpoint(rawConfig.aiBaseUrl);
  }

  if (rawConfig.agentRuntime === "remote-http") {
    validateAiEndpoint(rawConfig.remoteAgentBaseUrl);
    if (rawConfig.remoteAgentMcpWebSocketUrl) {
      let mcpUrl: URL;
      try {
        mcpUrl = new URL(rawConfig.remoteAgentMcpWebSocketUrl);
      } catch {
        throw new Error("Invalid NXCORE_REMOTE_AGENT_MCP_WS_URL: expected an absolute WS(S) URL");
      }
      if (mcpUrl.protocol !== "ws:" && mcpUrl.protocol !== "wss:") {
        throw new Error("Invalid NXCORE_REMOTE_AGENT_MCP_WS_URL: expected an absolute WS(S) URL");
      }
    }
  }

  if (rawConfig.asrProvider === "aliyun") {
    if (!rawConfig.asrAliyunApiKey) {
      throw new Error("Aliyun ASR requires: NXCORE_ASR_ALIYUN_API_KEY");
    }
    validateHttpEndpoint("NXCORE_ASR_ALIYUN_BASE_URL", rawConfig.asrAliyunBaseUrl);
    const ossFields = [
      ["NXCORE_ASR_ALIYUN_OSS_REGION", rawConfig.asrAliyunOssRegion],
      ["NXCORE_ASR_ALIYUN_OSS_BUCKET", rawConfig.asrAliyunOssBucket],
      ["NXCORE_ASR_ALIYUN_OSS_ACCESS_KEY_ID", rawConfig.asrAliyunOssAccessKeyId],
      ["NXCORE_ASR_ALIYUN_OSS_ACCESS_KEY_SECRET", rawConfig.asrAliyunOssAccessKeySecret],
    ] as const;
    if (ossFields.some(([, value]) => value) && ossFields.some(([, value]) => !value)) {
      const missing = ossFields.filter(([, value]) => !value).map(([name]) => name);
      throw new Error(`Aliyun OSS configuration requires: ${missing.join(", ")}`);
    }
  }

  const memory: MemoryRuntimeConfig | null = rawConfig.memoryEnabled
    ? {
        baseUrl: rawConfig.memoryBaseUrl,
        apiKey: rawConfig.memoryApiKey,
        serviceId: rawConfig.memoryServiceId,
        teamId: rawConfig.memoryTeamId,
        agentId: rawConfig.memoryAgentId,
        userId: rawConfig.memoryUserId,
        recallLimit: rawConfig.memoryRecallLimit,
        charBudget: rawConfig.memoryCharBudget,
      }
    : null;
  if (memory) {
    validateMemoryEndpoint("NXCORE_MEMORY_BASE_URL", memory.baseUrl);
  }

  const knowledge: KnowledgeRuntimeConfig | null = rawConfig.knowledgeEnabled
    ? {
        baseUrl: rawConfig.knowledgeBaseUrl,
        serviceId: rawConfig.knowledgeServiceId,
        teamId: rawConfig.knowledgeTeamId,
        // Room 级 wiki 模式下 wiki 由会话按 roomId 解析，wikiId 仅作
        // Room 未命中时的回退（全局 wiki 已随方案取消，仅保留旧配置兼容）。
        ...(rawConfig.knowledgeWikiId ? { wikiId: rawConfig.knowledgeWikiId } : {}),
        searchLimit: 5,
      }
    : null;
  if (knowledge) {
    validateMemoryEndpoint("NXCORE_KNOWLEDGE_BASE_URL", knowledge.baseUrl);
    if (!knowledge.wikiId && !rawConfig.knowledgeRoomWikisEnabled) {
      throw new Error(
        "Knowledge service requires: NXCORE_KNOWLEDGE_WIKI_ID (or enable NXCORE_KNOWLEDGE_ROOM_WIKIS_ENABLED)",
      );
    }
  }

  // ⑤ 的 LLM 独立配置优先，缺项回退 NXCORE_AI_*；base/key/model 三者齐全才算可用。
  const knowledgeLlmBaseUrl = rawConfig.knowledgeLlmBaseUrl || rawConfig.aiBaseUrl;
  const knowledgeLlmApiKey = rawConfig.knowledgeLlmApiKey || rawConfig.aiApiKey;
  const knowledgeLlmModel = rawConfig.knowledgeLlmModel || rawConfig.aiModel;
  const knowledgeGateway: KnowledgeGatewayConfig | null = rawConfig.knowledgeEnabled
    ? {
        baseUrl: rawConfig.knowledgeBaseUrl,
        serviceId: rawConfig.knowledgeServiceId,
        teamId: rawConfig.knowledgeTeamId,
        roomWikisEnabled: rawConfig.knowledgeRoomWikisEnabled,
        ingestDebounceMs: rawConfig.knowledgeIngestDebounceMs,
        routerEnabled: rawConfig.knowledgeRouterEnabled,
        routeThresholdAuto: rawConfig.knowledgeRouteThresholdAuto,
        routeThresholdReview: rawConfig.knowledgeRouteThresholdReview,
        autoCreateRoomEnabled: rawConfig.knowledgeAutoCreateRoomEnabled,
        llm: knowledgeLlmBaseUrl && knowledgeLlmApiKey && knowledgeLlmModel
          ? {
              baseUrl: knowledgeLlmBaseUrl,
              apiKey: knowledgeLlmApiKey,
              model: knowledgeLlmModel,
            }
          : null,
        // ④ 只需要 base/key（模型名单列）；与 ⑤ 共用同一套回退。
        embeddingLlm: knowledgeLlmBaseUrl && knowledgeLlmApiKey
          ? {
              baseUrl: knowledgeLlmBaseUrl,
              apiKey: knowledgeLlmApiKey,
              model: knowledgeLlmModel,
            }
          : null,
        embeddingModel: rawConfig.knowledgeEmbeddingModel,
      }
    : null;
  if (knowledgeGateway?.routerEnabled) {
    if (knowledgeGateway.routeThresholdReview >= knowledgeGateway.routeThresholdAuto) {
      throw new Error(
        "Invalid knowledge route thresholds: THRESHOLD_REVIEW must be lower than THRESHOLD_AUTO",
      );
    }
    // ⑤ 未配置 LLM 时 router 仍可运行（M1 形态：③④ 候选 → 待归类队列，人工即仲裁者）；
    // 唯独 auto-create 依赖 ⑤ 的 create_new 判决，没有 LLM 就无从谈起。
    if (knowledgeGateway.autoCreateRoomEnabled && !knowledgeGateway.llm) {
      throw new Error(
        "NXCORE_KNOWLEDGE_AUTO_CREATE_ROOM_ENABLED requires an LLM for arbitration: set "
          + "NXCORE_KNOWLEDGE_LLM_BASE_URL/KEY/MODEL or NXCORE_AI_BASE_URL/KEY/MODEL",
      );
    }
  }

  return {
    host: rawConfig.host,
    port: rawConfig.port,
    dataDir: rawConfig.dataDir,
    logLevel: rawConfig.logLevel,
    authToken: rawConfig.authToken,
    agentRuntime: rawConfig.agentRuntime,
    remoteAgent: rawConfig.agentRuntime === "remote-http"
      ? {
          baseUrl: rawConfig.remoteAgentBaseUrl,
          token: rawConfig.remoteAgentToken || null,
          mcpWebSocketUrl: rawConfig.remoteAgentMcpWebSocketUrl || null,
        }
      : null,
    databasePath: join(dataDir, "database", "gateway.sqlite"),
    migrationsDir: resolve(
      values["migrations-dir"] ?? env.NXCORE_GATEWAY_MIGRATIONS_DIR ?? defaultMigrationsDir(),
    ),
    runtimeManifestPath: join(dataDir, "runtime", "gateway.json"),
    asrInputDir: join(dataDir, "recordings"),
    asr: rawConfig.asrProvider === "aliyun"
      ? {
          apiKey: rawConfig.asrAliyunApiKey,
          baseUrl: rawConfig.asrAliyunBaseUrl,
          model: rawConfig.asrAliyunModel,
          oss: rawConfig.asrAliyunOssRegion
            ? {
                region: rawConfig.asrAliyunOssRegion,
                bucket: rawConfig.asrAliyunOssBucket,
                accessKeyId: rawConfig.asrAliyunOssAccessKeyId,
                accessKeySecret: rawConfig.asrAliyunOssAccessKeySecret,
                ...(rawConfig.asrAliyunOssStsToken
                  ? { stsToken: rawConfig.asrAliyunOssStsToken }
                  : {}),
                prefix: rawConfig.asrAliyunOssPrefix.replace(/^\/+|\/+$/g, ""),
              }
            : null,
        }
      : null,
    pi: rawConfig.agentRuntime === "pi"
      ? {
          provider: rawConfig.aiProvider,
          model: rawConfig.aiModel,
          baseUrl: rawConfig.aiBaseUrl,
          apiKey: rawConfig.aiApiKey,
          api: rawConfig.aiApi,
          maxTokens: rawConfig.aiMaxTokens,
          contextWindow: rawConfig.aiContextWindow,
          temperature: rawConfig.aiTemperature,
          reasoning: rawConfig.aiReasoning,
          sessionsDir: join(dataDir, "agent", "pi-sessions"),
          workingDirectory: join(dataDir, "agent", "workspace"),
          agentDirectory: join(dataDir, "agent", "pi-config"),
          ...(memory ? { memory } : {}),
          ...(knowledge ? { knowledge } : {}),
        }
      : null,
    knowledge: knowledgeGateway,
  };
}
