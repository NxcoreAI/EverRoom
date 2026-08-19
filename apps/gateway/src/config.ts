import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { MemoryRuntimeConfig } from "@nxcore/agent-runtime-pi";

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
]);
const ConnectorAgentModeSchema = Type.Union([
  Type.Literal("direct"),
  Type.Literal("local"),
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
    connectorAgentMode: ConnectorAgentModeSchema,
    connectorSyncEnabled: Type.Boolean(),
    connectorSyncJobsJson: Type.String(),
    connectorSyncIntervalMs: Type.Integer({ minimum: 5_000 }),
    connectorSyncOwnerId: Type.String({ minLength: 1, maxLength: 128 }),
    aiProvider: Type.String(),
    aiModel: Type.String(),
    aiBackgroundModel: Type.String(),
    aiBaseUrl: Type.String(),
    aiApiKey: Type.String(),
    aiApi: AiApiSchema,
    aiMaxTokens: Type.Integer({ minimum: 1 }),
    aiBackgroundMaxTokens: Type.Integer({ minimum: 1 }),
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
  },
  { additionalProperties: false },
);

export type LogLevel = typeof LogLevelSchema.static;
export type AgentRuntimeMode = typeof AgentRuntimeSchema.static;
export type ConnectorAgentMode = typeof ConnectorAgentModeSchema.static;
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
}

export interface OpenConnectorCliConfig {
  executable: string;
  baseUrl: string;
  runtimeToken?: string;
  configDirectory: string;
  dataDirectory: string;
}

export interface ConnectorSyncJobConfig {
  id: string;
  ownerId: string;
  service: string;
  action?: string;
  allowedActions: string[];
  dataset: string;
  resourceType: "email" | "document" | "calendar" | "generic";
  connectionName?: string;
  input: Record<string, unknown>;
  goal: string;
  prompt?: string;
  promptVersion: number;
  schemaVersion: number;
  intervalMs?: number;
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
  connectorAgentMode?: ConnectorAgentMode;
  connectorSyncEnabled?: boolean;
  connectorSyncIntervalMs?: number;
  connectorSyncJobs?: ConnectorSyncJobConfig[];
  connectorSyncOwnerId?: string;
  memory: MemoryRuntimeConfig | null;
  pi: PiRuntimeConfig | null;
  backgroundPi: PiRuntimeConfig | null;
  asrInputDir: string;
  asr: AliyunAsrConfig | null;
  openConnector?: OpenConnectorCliConfig | null;
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

function parseTemperature(value: string): number {
  const temperature = Number(value);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error(`Invalid NXCORE_AI_TEMPERATURE: ${value}`);
  }
  return temperature;
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

function validateConnectorEndpoint(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid OO_CONNECTOR_URL: expected an absolute HTTP(S) URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Invalid OO_CONNECTOR_URL: plain HTTP is only allowed for loopback addresses');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid OO_CONNECTOR_URL: credentials, query, and fragment are not allowed');
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

function parseConnectorSyncJobs(value: string): ConnectorSyncJobConfig[] {
  if (!value.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("NXCORE_CONNECTOR_SYNC_JOBS must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("NXCORE_CONNECTOR_SYNC_JOBS must be a JSON array");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`NXCORE_CONNECTOR_SYNC_JOBS[${String(index)}] must be an object`);
    }
    const job = item as Record<string, unknown>;
    const required = ["id", "ownerId", "service", "dataset"] as const;
    for (const key of required) {
      if (typeof job[key] !== "string" || !job[key].trim()) {
        throw new Error(`NXCORE_CONNECTOR_SYNC_JOBS[${String(index)}].${key} is required`);
      }
    }
    if (job.input !== undefined && (!job.input || typeof job.input !== "object" || Array.isArray(job.input))) {
      throw new Error(`NXCORE_CONNECTOR_SYNC_JOBS[${String(index)}].input must be an object`);
    }
    if (job.intervalMs !== undefined && (!Number.isInteger(job.intervalMs) || Number(job.intervalMs) < 5_000)) {
      throw new Error(`NXCORE_CONNECTOR_SYNC_JOBS[${String(index)}].intervalMs must be at least 5000`);
    }
    const resourceType = typeof job.resourceType === "string"
      ? job.resourceType.trim()
      : inferConnectorResourceType(String(job.dataset));
    if (resourceType !== "email" && resourceType !== "document" && resourceType !== "calendar" && resourceType !== "generic") {
      throw new Error(`NXCORE_CONNECTOR_SYNC_JOBS[${String(index)}].resourceType must be email, document, calendar, or generic`);
    }
    const action = typeof job.action === "string" && job.action.trim() ? job.action.trim() : undefined;
    if (job.allowedActions !== undefined && (!Array.isArray(job.allowedActions)
      || job.allowedActions.some((item) => typeof item !== "string" || !item.trim()))) {
      throw new Error(`NXCORE_CONNECTOR_SYNC_JOBS[${String(index)}].allowedActions must be an array of action names`);
    }
    const allowedActions = [...new Set([
      ...(action ? [action] : []),
      ...((job.allowedActions as string[] | undefined) ?? []).map((item) => item.trim()),
    ])];
    if (allowedActions.length === 0) {
      throw new Error(`NXCORE_CONNECTOR_SYNC_JOBS[${String(index)}] requires action or allowedActions`);
    }
    if (resourceType !== "generic") {
      const unsafeAction = allowedActions.find(isObviouslyMutatingConnectorAction);
      if (unsafeAction) {
        throw new Error(`NXCORE_CONNECTOR_SYNC_JOBS[${String(index)}] action "${unsafeAction}" is not read-only`);
      }
    }
    return {
      id: String(job.id).trim(),
      ownerId: String(job.ownerId).trim(),
      service: String(job.service).trim(),
      ...(action ? { action } : {}),
      allowedActions,
      dataset: String(job.dataset).trim(),
      resourceType: resourceType ?? "generic",
      ...(typeof job.connectionName === "string" && job.connectionName.trim()
        ? { connectionName: job.connectionName.trim() }
        : {}),
      input: (job.input as Record<string, unknown> | undefined) ?? {},
      goal: typeof job.goal === "string" && job.goal.trim()
        ? job.goal.trim()
        : `同步已授权 ${String(job.service).trim()} 中的 ${resourceType} 数据到 EverRoom 本地数据库。`,
      ...(typeof job.prompt === "string" && job.prompt.trim() ? { prompt: job.prompt.trim() } : {}),
      promptVersion: Number.isInteger(job.promptVersion) && Number(job.promptVersion) > 0
        ? Number(job.promptVersion)
        : 1,
      schemaVersion: Number.isInteger(job.schemaVersion) && Number(job.schemaVersion) > 0
        ? Number(job.schemaVersion)
        : 1,
      ...(job.intervalMs !== undefined ? { intervalMs: Number(job.intervalMs) } : {}),
    };
  });
}

function inferConnectorResourceType(dataset: string): "email" | "document" | "calendar" | "generic" {
  const normalized = dataset.trim().toLowerCase();
  if (/mail|email|message/.test(normalized)) return "email";
  if (/doc|page|file/.test(normalized)) return "document";
  if (/calendar|event|schedule/.test(normalized)) return "calendar";
  return "generic";
}

function isObviouslyMutatingConnectorAction(action: string): boolean {
  return /^(?:send|create|update|delete|remove|modify|mark|archive|trash|move|share|invite|reply|upload|post|put|patch|add|set)(?:_|-)/i.test(action);
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
  const rawConfig = {
    host: values.host ?? env.NXCORE_GATEWAY_HOST ?? "127.0.0.1",
    port: parsePort(values.port ?? env.NXCORE_GATEWAY_PORT ?? "0"),
    dataDir,
    logLevel: values["log-level"] ?? env.NXCORE_GATEWAY_LOG_LEVEL ?? "info",
    authToken: values.token ?? env.NXCORE_GATEWAY_TOKEN ?? randomBytes(32).toString("base64url"),
    agentRuntime: env.NXCORE_AGENT_RUNTIME ?? "fake",
    connectorAgentMode: env.NXCORE_CONNECTOR_AGENT_MODE ?? "direct",
    connectorSyncEnabled: env.NXCORE_CONNECTOR_SYNC_ENABLED == null
      ? false
      : parseBoolean("NXCORE_CONNECTOR_SYNC_ENABLED", env.NXCORE_CONNECTOR_SYNC_ENABLED.trim()),
    connectorSyncJobsJson: env.NXCORE_CONNECTOR_SYNC_JOBS?.trim() ?? "",
    connectorSyncIntervalMs: parsePositiveInteger(
      "NXCORE_CONNECTOR_SYNC_INTERVAL_MS",
      env.NXCORE_CONNECTOR_SYNC_INTERVAL_MS ?? "300000",
    ),
    connectorSyncOwnerId: env.NXCORE_CONNECTOR_SYNC_OWNER_ID?.trim() || "local-user",
    aiProvider: env.NXCORE_AI_PROVIDER?.trim() ?? "",
    aiModel: env.NXCORE_AI_MODEL?.trim() ?? "",
    aiBackgroundModel: env.NXCORE_AI_BACKGROUND_MODEL?.trim() || env.NXCORE_AI_MODEL?.trim() || "",
    aiBaseUrl: env.NXCORE_AI_BASE_URL?.trim() ?? "",
    aiApiKey: env.NXCORE_AI_API_KEY?.trim() ?? "",
    aiApi: env.NXCORE_AI_API ?? "openai-completions",
    aiMaxTokens: parsePositiveInteger("NXCORE_AI_MAX_TOKENS", env.NXCORE_AI_MAX_TOKENS ?? "8192"),
    aiBackgroundMaxTokens: parsePositiveInteger(
      "NXCORE_AI_BACKGROUND_MAX_TOKENS",
      env.NXCORE_AI_BACKGROUND_MAX_TOKENS ?? "4096",
    ),
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

  const pi: PiRuntimeConfig | null = rawConfig.agentRuntime === "pi"
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
      }
    : null;
  const openConnectorUrl = env.OO_CONNECTOR_URL?.trim();
  if (openConnectorUrl) validateConnectorEndpoint(openConnectorUrl);
  const connectorSyncJobs = parseConnectorSyncJobs(rawConfig.connectorSyncJobsJson);

  return {
    host: rawConfig.host,
    port: rawConfig.port,
    dataDir: rawConfig.dataDir,
    logLevel: rawConfig.logLevel,
    authToken: rawConfig.authToken,
    agentRuntime: rawConfig.agentRuntime,
    connectorAgentMode: rawConfig.connectorAgentMode,
    connectorSyncEnabled: rawConfig.connectorSyncEnabled,
    connectorSyncIntervalMs: rawConfig.connectorSyncIntervalMs,
    connectorSyncJobs,
    connectorSyncOwnerId: rawConfig.connectorSyncOwnerId,
    memory,
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
    openConnector: openConnectorUrl
      ? {
          executable: env.NXCORE_OO_CLI_PATH?.trim() || 'oo',
          baseUrl: openConnectorUrl.replace(/\/$/, ''),
          ...(env.OO_CONNECTOR_TOKEN?.trim() ? { runtimeToken: env.OO_CONNECTOR_TOKEN.trim() } : {}),
          configDirectory: env.OO_CONFIG_DIR?.trim() || join(dataDir, 'open-connector', 'oo-config'),
          dataDirectory: env.OO_DATA_DIR?.trim() || join(dataDir, 'open-connector', 'oo-data'),
        }
      : null,
    pi,
    backgroundPi: pi
      ? {
          ...pi,
          model: rawConfig.aiBackgroundModel,
          maxTokens: rawConfig.aiBackgroundMaxTokens,
        }
      : null,
  };
}
