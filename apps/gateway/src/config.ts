import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
]);
const CliConnectorAgentModeSchema = Type.Union([
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
    subagentsEnabled: Type.Boolean(),
    subagentsDir: Type.String(),
    subagentTimeoutMs: Type.Integer({ minimum: 1_000 }),
    subagentMaxConcurrent: Type.Integer({ minimum: 1, maximum: 64 }),
    cliConnectorAgentMode: CliConnectorAgentModeSchema,
    cliConnectorSyncEnabled: Type.Boolean(),
    cliConnectorSyncJobsJson: Type.String(),
    cliConnectorSyncIntervalMs: Type.Integer({ minimum: 5_000 }),
    cliConnectorSyncOwnerId: Type.String({ minLength: 1, maxLength: 128 }),
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
    cursorCompletionAiProvider: Type.String(),
    cursorCompletionAiModel: Type.String(),
    cursorCompletionAiBaseUrl: Type.String(),
    cursorCompletionAiApiKey: Type.String(),
    cursorCompletionAiApi: AiApiSchema,
    cursorCompletionAiMaxTokens: Type.Integer({ minimum: 1 }),
    cursorCompletionAiContextWindow: Type.Integer({ minimum: 1 }),
    cursorCompletionAiTemperature: Type.Number({ minimum: 0, maximum: 2 }),
    cursorCompletionAiReasoning: AiReasoningSchema,
    piBuiltinTools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    webSearchEnabled: Type.Boolean(),
    webSearchBaseUrl: Type.String(),
    webSearchModel: Type.String({ minLength: 1 }),
    webSearchApiKey: Type.String(),
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
    nangoUrl: Type.String(),
    nangoSecret: Type.String(),
    nangoConnectorPollMs: Type.Integer({ minimum: 1000 }),
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
    knowledgeEntityPromoteScore: Type.Number({ exclusiveMinimum: 0 }),
    knowledgeEntityPromoteSources: Type.Integer({ minimum: 1 }),
    knowledgeEntityMergeAutoDice: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    knowledgeEntityMergeJudgeDice: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    knowledgeLlmBaseUrl: Type.String(),
    knowledgeLlmApiKey: Type.String(),
    knowledgeLlmModel: Type.String(),
    knowledgeEmbeddingModel: Type.String(),
    knowledgeEmbeddingBaseUrl: Type.String(),
    knowledgeEmbeddingApiKey: Type.String(),
  },
  { additionalProperties: false },
);

export type LogLevel = typeof LogLevelSchema.static;
export type AgentRuntimeMode = typeof AgentRuntimeSchema.static;
export type CliConnectorAgentMode = typeof CliConnectorAgentModeSchema.static;
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

/** 百炼（DashScope compatible-mode）联网搜索配置，注入 agent 的 web_search 工具。 */
export interface WebSearchConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface PiRuntimeConfig {
  runtimeId?: string;
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
  systemPrompt?: string;
  skillsEnabled?: boolean;
  includeBashTool?: boolean;
  maxToolCallsPerRun?: number;
  /** Pi 内置工具白名单；缺省启用全部，NXCORE_PI_TOOLS（逗号分隔）收窄。 */
  builtinTools?: string[];
  /** MCP 服务器注入配置（pi-mcp-adapter）；读取 NXCORE_MCP_CONFIG 或 dataDir/agent/mcp.json。 */
  mcp?: { mcpServers: Record<string, unknown> };
  memory?: MemoryRuntimeConfig;
  knowledge?: KnowledgeRuntimeConfig;
}

/** gateway 侧 knowledge 模块配置（Room wiki 注册表 + 实体晋升制，docs/entity-room-plan.md §6）。 */export interface KnowledgeGatewayConfig {
  baseUrl: string;
  serviceId: string;
  teamId: string;
  /** Room 级 wiki 总开关；关闭时本模块不接管任何文档事件。 */
  roomWikisEnabled: boolean;
  /** 文档落定后的入队防抖窗口（毫秒）。 */
  ingestDebounceMs: number;
  /** 自动归类路由总开关（③′抽取→③″解析→④链接）；关闭时仅 ① 入口直连 ingest。 */
  routerEnabled: boolean;
  /** 晋升证据分阈值（primary +1.0 / mention +0.4 / manual +1.5 累积）。 */
  entityPromoteScore: number;
  /** 晋升最小资料数（防单份资料多角色刷分）。 */
  entityPromoteSources: number;
  /** 弱-弱确定性自动合并线（免 LLM 判定）。 */
  mergeAutoDice: number;
  /** LLM 同一性判定带下限（[judge, auto) 走判定）。 */
  mergeJudgeDice: number;
  /** 抽取/判定/登记用的 LLM；缺省回退 NXCORE_AI_*。 */
  llm: KnowledgeLlmConfig | null;
  /** 消歧 tie-break 的 embedding 端点（与抽取 LLM 同源配置）。 */
  embeddingLlm: KnowledgeLlmConfig | null;
  /** embedding 模型；空 = 关闭（消歧回退证据分高者）。 */
  embeddingModel: string;
}

export interface KnowledgeLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
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
  cliConnectorAgentMode?: CliConnectorAgentMode;
  cliConnectorSyncEnabled?: boolean;
  cliConnectorSyncIntervalMs?: number;
  cliConnectorSyncJobs?: ConnectorSyncJobConfig[];
  cliConnectorSyncOwnerId?: string;
  memory: MemoryRuntimeConfig | null;
  pi: PiRuntimeConfig | null;
  cursorCompletionPi: PiRuntimeConfig | null;
  knowledge: KnowledgeGatewayConfig | null;
  backgroundPi: PiRuntimeConfig | null;
  subagents?: SubagentFrameworkConfig;
  /** agent MCP 配置文件绝对路径（设置页管理用）。 */
  mcpConfigPath: string;
  /** 百炼（DashScope）联网搜索工具配置；null 时 agent 不提供 web_search。 */
  webSearch: WebSearchConfig | null;
  asrInputDir: string;
  asr: AliyunAsrConfig | null;
  nangoConnector?: {
    enabled: boolean;
    databasePath: string;
    nangoUrl: string;
    nangoSecret: string;
    gmailConfigKey: string;
    outlookConfigKey: string;
    googleDocsConfigKey: string;
    notionConfigKey: string;
    googleCalendarConfigKey: string;
    googleClientId: string;
    googleClientSecret: string;
    notionClientId: string;
    notionClientSecret: string;
    outlookClientId: string;
    outlookClientSecret: string;
    pollingIntervalMs: number;
  };
  cliConnector?: OpenConnectorCliConfig | null;
}

export interface SubagentFrameworkConfig {
  enabled: boolean;
  definitionsDir: string;
  runtimeDir: string;
  defaultTimeoutMs: number;
  maxConcurrent: number;
}

/** agent MCP 配置文件路径（NXCORE_MCP_CONFIG 优先，缺省 dataDir/agent/mcp.json）。 */
export function resolveMcpConfigPath(dataDir: string, overridePath?: string): string {
  return resolve(overridePath?.trim() || join(dataDir, "agent", "mcp.json"));
}

/** 读取 agent MCP 服务器配置（.mcp.json 格式，仅取 mcpServers 字段）；缺省或解析失败返回空。 */
function loadMcpServers(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
      console.error(`[config] ${configPath} 缺少 mcpServers 字段，忽略 MCP 配置`);
      return {};
    }
    return parsed.mcpServers;
  } catch (error) {
    console.error(`[config] 解析 MCP 配置失败（${configPath}）：${error instanceof Error ? error.message : error}`);
    return {};
  }
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

function parseTemperature(value: string, name = "NXCORE_AI_TEMPERATURE"): number {
  const temperature = Number(value);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error(`Invalid ${name}: ${value}`);
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

/** 晋升证据分阈值等正实数配置用这个。 */
function parsePositiveNumber(name: string, value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid ${name}: expected a positive number`);
  }
  return number;
}

function validateAiEndpoint(value: string, name = "NXCORE_AI_BASE_URL"): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: expected an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid ${name}: expected an absolute HTTP(S) URL`);
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

function validateConnectorEndpoint(name: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: expected an absolute HTTP(S) URL`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`Invalid ${name}: plain HTTP is only allowed for loopback addresses`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid ${name}: credentials, query, and fragment are not allowed`);
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
    throw new Error("NXCORE_CLI_CONNECTOR_SYNC_JOBS must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("NXCORE_CLI_CONNECTOR_SYNC_JOBS must be a JSON array");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`NXCORE_CLI_CONNECTOR_SYNC_JOBS[${String(index)}] must be an object`);
    }
    const job = item as Record<string, unknown>;
    const required = ["id", "ownerId", "service", "dataset"] as const;
    for (const key of required) {
      if (typeof job[key] !== "string" || !job[key].trim()) {
        throw new Error(`NXCORE_CLI_CONNECTOR_SYNC_JOBS[${String(index)}].${key} is required`);
      }
    }
    if (job.input !== undefined && (!job.input || typeof job.input !== "object" || Array.isArray(job.input))) {
      throw new Error(`NXCORE_CLI_CONNECTOR_SYNC_JOBS[${String(index)}].input must be an object`);
    }
    if (job.intervalMs !== undefined && (!Number.isInteger(job.intervalMs) || Number(job.intervalMs) < 5_000)) {
      throw new Error(`NXCORE_CLI_CONNECTOR_SYNC_JOBS[${String(index)}].intervalMs must be at least 5000`);
    }
    const resourceType = typeof job.resourceType === "string"
      ? job.resourceType.trim()
      : inferConnectorResourceType(String(job.dataset));
    if (resourceType !== "email" && resourceType !== "document" && resourceType !== "calendar" && resourceType !== "generic") {
      throw new Error(`NXCORE_CLI_CONNECTOR_SYNC_JOBS[${String(index)}].resourceType must be email, document, calendar, or generic`);
    }
    const action = typeof job.action === "string" && job.action.trim() ? job.action.trim() : undefined;
    if (job.allowedActions !== undefined && (!Array.isArray(job.allowedActions)
      || job.allowedActions.some((item) => typeof item !== "string" || !item.trim()))) {
      throw new Error(`NXCORE_CLI_CONNECTOR_SYNC_JOBS[${String(index)}].allowedActions must be an array of action names`);
    }
    const allowedActions = [...new Set([
      ...(action ? [action] : []),
      ...((job.allowedActions as string[] | undefined) ?? []).map((item) => item.trim()),
    ])];
    if (allowedActions.length === 0) {
      throw new Error(`NXCORE_CLI_CONNECTOR_SYNC_JOBS[${String(index)}] requires action or allowedActions`);
    }
    if (resourceType !== "generic") {
      const unsafeAction = allowedActions.find(isObviouslyMutatingConnectorAction);
      if (unsafeAction) {
        throw new Error(`NXCORE_CLI_CONNECTOR_SYNC_JOBS[${String(index)}] action "${unsafeAction}" is not read-only`);
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
    subagentsEnabled: env.NXCORE_SUBAGENTS_ENABLED == null
      ? true
      : parseBoolean("NXCORE_SUBAGENTS_ENABLED", env.NXCORE_SUBAGENTS_ENABLED.trim()),
    subagentsDir: env.NXCORE_SUBAGENTS_DIR?.trim() ?? "",
    subagentTimeoutMs: parsePositiveInteger(
      "NXCORE_SUBAGENT_TIMEOUT_MS",
      env.NXCORE_SUBAGENT_TIMEOUT_MS ?? "300000",
    ),
    subagentMaxConcurrent: parsePositiveInteger(
      "NXCORE_SUBAGENT_MAX_CONCURRENT",
      env.NXCORE_SUBAGENT_MAX_CONCURRENT ?? "4",
    ),
    cliConnectorAgentMode: env.NXCORE_CLI_CONNECTOR_AGENT_MODE ?? "direct",
    cliConnectorSyncEnabled: env.NXCORE_CLI_CONNECTOR_SYNC_ENABLED == null
      ? false
      : parseBoolean("NXCORE_CLI_CONNECTOR_SYNC_ENABLED", env.NXCORE_CLI_CONNECTOR_SYNC_ENABLED.trim()),
    cliConnectorSyncJobsJson: env.NXCORE_CLI_CONNECTOR_SYNC_JOBS?.trim() ?? "",
    cliConnectorSyncIntervalMs: parsePositiveInteger(
      "NXCORE_CLI_CONNECTOR_SYNC_INTERVAL_MS",
      env.NXCORE_CLI_CONNECTOR_SYNC_INTERVAL_MS ?? "300000",
    ),
    cliConnectorSyncOwnerId: env.NXCORE_CLI_CONNECTOR_SYNC_OWNER_ID?.trim() || "local-user",
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
    cursorCompletionAiProvider: env.NXCORE_CURSOR_COMPLETION_AI_PROVIDER?.trim()
      || env.NXCORE_AI_PROVIDER?.trim() || "",
    cursorCompletionAiModel: env.NXCORE_CURSOR_COMPLETION_AI_MODEL?.trim()
      || env.NXCORE_AI_MODEL?.trim() || "",
    cursorCompletionAiBaseUrl: env.NXCORE_CURSOR_COMPLETION_AI_BASE_URL?.trim()
      || env.NXCORE_AI_BASE_URL?.trim() || "",
    cursorCompletionAiApiKey: env.NXCORE_CURSOR_COMPLETION_AI_API_KEY?.trim()
      || env.NXCORE_AI_API_KEY?.trim() || "",
    cursorCompletionAiApi: env.NXCORE_CURSOR_COMPLETION_AI_API?.trim()
      || env.NXCORE_AI_API?.trim() || "openai-completions",
    cursorCompletionAiMaxTokens: parsePositiveInteger(
      "NXCORE_CURSOR_COMPLETION_AI_MAX_TOKENS",
      env.NXCORE_CURSOR_COMPLETION_AI_MAX_TOKENS ?? env.NXCORE_AI_MAX_TOKENS ?? "8192",
    ),
    cursorCompletionAiContextWindow: parsePositiveInteger(
      "NXCORE_CURSOR_COMPLETION_AI_CONTEXT_WINDOW",
      env.NXCORE_CURSOR_COMPLETION_AI_CONTEXT_WINDOW ?? env.NXCORE_AI_CONTEXT_WINDOW ?? "128000",
    ),
    cursorCompletionAiTemperature: parseTemperature(
      env.NXCORE_CURSOR_COMPLETION_AI_TEMPERATURE ?? env.NXCORE_AI_TEMPERATURE ?? "0.3",
      env.NXCORE_CURSOR_COMPLETION_AI_TEMPERATURE === undefined
        ? "NXCORE_AI_TEMPERATURE"
        : "NXCORE_CURSOR_COMPLETION_AI_TEMPERATURE",
    ),
    cursorCompletionAiReasoning: env.NXCORE_CURSOR_COMPLETION_AI_REASONING?.trim()
      || env.NXCORE_AI_REASONING?.trim() || "medium",
    piBuiltinTools: env.NXCORE_PI_TOOLS?.trim()
      ? env.NXCORE_PI_TOOLS.split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      : undefined,
    webSearchEnabled: env.NXCORE_WEB_SEARCH == null
      ? true
      : parseBoolean("NXCORE_WEB_SEARCH", env.NXCORE_WEB_SEARCH.trim()),
    webSearchBaseUrl: env.NXCORE_WEB_SEARCH_BASE_URL?.trim()
      ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    webSearchModel: env.NXCORE_WEB_SEARCH_MODEL?.trim() ?? "qwen-plus",
    webSearchApiKey: env.NXCORE_WEB_SEARCH_API_KEY?.trim() ?? env.NXCORE_AI_API_KEY?.trim() ?? "",
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
    nangoUrl: env.NXCORE_NANGO_CONNECTOR_URL?.trim() ?? "",
    nangoSecret: env.NXCORE_NANGO_CONNECTOR_SECRET?.trim() ?? "",
    nangoConnectorPollMs: parsePositiveInteger(
      "NXCORE_NANGO_CONNECTOR_POLL_MS",
      env.NXCORE_NANGO_CONNECTOR_POLL_MS ?? "300000",
    ),
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
    knowledgeEntityPromoteScore: parsePositiveNumber(
      "NXCORE_KNOWLEDGE_ENTITY_PROMOTE_SCORE",
      env.NXCORE_KNOWLEDGE_ENTITY_PROMOTE_SCORE ?? "2.0",
    ),
    knowledgeEntityPromoteSources: parsePositiveInteger(
      "NXCORE_KNOWLEDGE_ENTITY_PROMOTE_SOURCES",
      env.NXCORE_KNOWLEDGE_ENTITY_PROMOTE_SOURCES ?? "2",
    ),
    knowledgeEntityMergeAutoDice: parseFraction(
      "NXCORE_KNOWLEDGE_ENTITY_MERGE_AUTO_DICE",
      env.NXCORE_KNOWLEDGE_ENTITY_MERGE_AUTO_DICE ?? "0.75",
    ),
    knowledgeEntityMergeJudgeDice: parseFraction(
      "NXCORE_KNOWLEDGE_ENTITY_MERGE_JUDGE_DICE",
      env.NXCORE_KNOWLEDGE_ENTITY_MERGE_JUDGE_DICE ?? "0.6",
    ),
    knowledgeLlmBaseUrl: env.NXCORE_KNOWLEDGE_LLM_BASE_URL?.trim() ?? "",
    knowledgeLlmApiKey: env.NXCORE_KNOWLEDGE_LLM_API_KEY?.trim() ?? "",
    knowledgeLlmModel: env.NXCORE_KNOWLEDGE_LLM_MODEL?.trim() ?? "",
    knowledgeEmbeddingModel: env.NXCORE_KNOWLEDGE_EMBEDDING_MODEL?.trim() ?? "",
    knowledgeEmbeddingBaseUrl: env.NXCORE_KNOWLEDGE_EMBEDDING_BASE_URL?.trim() ?? "",
    knowledgeEmbeddingApiKey: env.NXCORE_KNOWLEDGE_EMBEDDING_API_KEY?.trim() ?? "",
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
  if (Boolean(rawConfig.nangoUrl) !== Boolean(rawConfig.nangoSecret)) throw new Error("Nango connector configuration requires both NXCORE_NANGO_CONNECTOR_URL and NXCORE_NANGO_CONNECTOR_SECRET");
  if (rawConfig.nangoUrl) { const u=new URL(rawConfig.nangoUrl); if (u.protocol!=="https:" && !(u.protocol==="http:" && ["localhost","127.0.0.1","::1"].includes(u.hostname))) throw new Error("NXCORE_NANGO_CONNECTOR_URL must use HTTPS except for loopback development"); }

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
  // 消歧 embedding 可指向别家（如 LLM 用 GLM、embedding 用 DashScope）；
  // 未独立配置时沿用抽取 LLM 的端点（历史行为）。
  const knowledgeEmbeddingBaseUrl = rawConfig.knowledgeEmbeddingBaseUrl || knowledgeLlmBaseUrl;
  const knowledgeEmbeddingApiKey = rawConfig.knowledgeEmbeddingApiKey || knowledgeLlmApiKey;
  const knowledgeGateway: KnowledgeGatewayConfig | null = rawConfig.knowledgeEnabled
    ? {
        baseUrl: rawConfig.knowledgeBaseUrl,
        serviceId: rawConfig.knowledgeServiceId,
        teamId: rawConfig.knowledgeTeamId,
        roomWikisEnabled: rawConfig.knowledgeRoomWikisEnabled,
        ingestDebounceMs: rawConfig.knowledgeIngestDebounceMs,
        routerEnabled: rawConfig.knowledgeRouterEnabled,
        entityPromoteScore: rawConfig.knowledgeEntityPromoteScore,
        entityPromoteSources: rawConfig.knowledgeEntityPromoteSources,
        mergeAutoDice: rawConfig.knowledgeEntityMergeAutoDice,
        mergeJudgeDice: rawConfig.knowledgeEntityMergeJudgeDice,
        llm: knowledgeLlmBaseUrl && knowledgeLlmApiKey && knowledgeLlmModel
          ? {
              baseUrl: knowledgeLlmBaseUrl,
              apiKey: knowledgeLlmApiKey,
              model: knowledgeLlmModel,
            }
          : null,
        // 消歧只需要 base/key（模型名单列）；缺省与抽取 LLM 同端点，但 embedding
        // 模型常在不同家（如 LLM 用 GLM、embedding 用 DashScope），故留独立
        // NXCORE_KNOWLEDGE_EMBEDDING_BASE_URL/API_KEY 覆盖位。
        embeddingLlm: knowledgeEmbeddingBaseUrl && knowledgeEmbeddingApiKey
          ? {
              baseUrl: knowledgeEmbeddingBaseUrl,
              apiKey: knowledgeEmbeddingApiKey,
              model: knowledgeLlmModel,
            }
          : null,
        embeddingModel: rawConfig.knowledgeEmbeddingModel,
      }
    : null;
  if (knowledgeGateway?.routerEnabled) {
    if (knowledgeGateway.mergeJudgeDice >= knowledgeGateway.mergeAutoDice) {
      throw new Error(
        "Invalid knowledge entity merge dice: MERGE_JUDGE_DICE must be lower than MERGE_AUTO_DICE",
      );
    }
    // 抽取未配置 LLM 时 router 仍可运行（全部落未识别栏人工挂载）；
    // 自动晋升依赖抽取产出的证据，没有 LLM 同样不会发生——不构成错误。
  }

  const mcpConfigPath = resolveMcpConfigPath(dataDir, env.NXCORE_MCP_CONFIG);
  const mcpServers = loadMcpServers(mcpConfigPath);
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
        ...(rawConfig.piBuiltinTools ? { builtinTools: rawConfig.piBuiltinTools } : {}),
        ...(Object.keys(mcpServers).length > 0 ? { mcp: { mcpServers } } : {}),
        ...(memory ? { memory } : {}),
        ...(knowledge ? { knowledge } : {}),
      }
    : null;
  const cursorCompletionPi: PiRuntimeConfig | null = rawConfig.agentRuntime === "pi"
    ? {
        provider: rawConfig.cursorCompletionAiProvider,
        model: rawConfig.cursorCompletionAiModel,
        baseUrl: rawConfig.cursorCompletionAiBaseUrl,
        apiKey: rawConfig.cursorCompletionAiApiKey,
        api: rawConfig.cursorCompletionAiApi,
        maxTokens: rawConfig.cursorCompletionAiMaxTokens,
        contextWindow: rawConfig.cursorCompletionAiContextWindow,
        temperature: rawConfig.cursorCompletionAiTemperature,
        reasoning: rawConfig.cursorCompletionAiReasoning,
        sessionsDir: join(dataDir, "agent", "cursor-completion-pi-sessions"),
        workingDirectory: join(dataDir, "agent", "cursor-completion-workspace"),
        agentDirectory: join(dataDir, "agent", "cursor-completion-pi-config"),
      }
    : null;
  if (cursorCompletionPi) {
    validateAiEndpoint(cursorCompletionPi.baseUrl, "NXCORE_CURSOR_COMPLETION_AI_BASE_URL");
  }
  const cliConnectorUrl = env.NXCORE_CLI_CONNECTOR_URL?.trim();
  if (cliConnectorUrl) validateConnectorEndpoint("NXCORE_CLI_CONNECTOR_URL", cliConnectorUrl);
  const cliConnectorSyncJobs = parseConnectorSyncJobs(rawConfig.cliConnectorSyncJobsJson);

  return {
    host: rawConfig.host,
    port: rawConfig.port,
    dataDir: rawConfig.dataDir,
    logLevel: rawConfig.logLevel,
    authToken: rawConfig.authToken,
    agentRuntime: rawConfig.agentRuntime,
    cliConnectorAgentMode: rawConfig.cliConnectorAgentMode,
    cliConnectorSyncEnabled: rawConfig.cliConnectorSyncEnabled,
    cliConnectorSyncIntervalMs: rawConfig.cliConnectorSyncIntervalMs,
    cliConnectorSyncJobs,
    cliConnectorSyncOwnerId: rawConfig.cliConnectorSyncOwnerId,
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
    nangoConnector: {
      enabled: Boolean(rawConfig.nangoUrl),
      databasePath: join(dataDir,"database","connectors.sqlite"),
      nangoUrl: rawConfig.nangoUrl,
      nangoSecret: rawConfig.nangoSecret,
      gmailConfigKey: env.NXCORE_NANGO_CONNECTOR_GMAIL_CONFIG_KEY?.trim() ?? "google-mail",
      outlookConfigKey: env.NXCORE_NANGO_CONNECTOR_OUTLOOK_CONFIG_KEY?.trim() ?? "microsoft-mail",
      googleDocsConfigKey: env.NXCORE_NANGO_CONNECTOR_GOOGLE_DOCS_CONFIG_KEY?.trim() ?? "google-drive",
      notionConfigKey: env.NXCORE_NANGO_CONNECTOR_NOTION_CONFIG_KEY?.trim() ?? "notion",
      googleCalendarConfigKey: env.NXCORE_NANGO_CONNECTOR_GOOGLE_CALENDAR_CONFIG_KEY?.trim() ?? "google-calendar",
      googleClientId: env.NXCORE_NANGO_CONNECTOR_GOOGLE_CLIENT_ID?.trim() ?? "",
      googleClientSecret: env.NXCORE_NANGO_CONNECTOR_GOOGLE_CLIENT_SECRET?.trim() ?? "",
      notionClientId: env.NXCORE_NANGO_CONNECTOR_NOTION_CLIENT_ID?.trim() ?? "",
      notionClientSecret: env.NXCORE_NANGO_CONNECTOR_NOTION_CLIENT_SECRET?.trim() ?? "",
      outlookClientId: env.NXCORE_NANGO_CONNECTOR_OUTLOOK_CLIENT_ID?.trim() ?? "",
      outlookClientSecret: env.NXCORE_NANGO_CONNECTOR_OUTLOOK_CLIENT_SECRET?.trim() ?? "",
      pollingIntervalMs: rawConfig.nangoConnectorPollMs,
    },
    cliConnector: cliConnectorUrl
      ? {
          executable: env.NXCORE_CLI_CONNECTOR_CLI_PATH?.trim() || 'oo',
          baseUrl: cliConnectorUrl.replace(/\/$/, ''),
          ...(env.NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN?.trim()
            ? { runtimeToken: env.NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN.trim() }
            : {}),
          configDirectory: env.NXCORE_CLI_CONNECTOR_CONFIG_DIR?.trim() || join(dataDir, 'open-connector', 'oo-config'),
          dataDirectory: env.NXCORE_CLI_CONNECTOR_DATA_DIR?.trim() || join(dataDir, 'open-connector', 'oo-data'),
        }
      : null,
    pi,
    cursorCompletionPi,
    backgroundPi: pi
      ? {
          ...pi,
          model: rawConfig.aiBackgroundModel,
          maxTokens: rawConfig.aiBackgroundMaxTokens,
        }
      : null,
    subagents: {
      enabled: rawConfig.subagentsEnabled,
      definitionsDir: resolve(rawConfig.subagentsDir || join(dataDir, "agents")),
      runtimeDir: join(dataDir, "agent", "subagents"),
      defaultTimeoutMs: rawConfig.subagentTimeoutMs,
      maxConcurrent: rawConfig.subagentMaxConcurrent,
    },
    mcpConfigPath,
    webSearch: pi && rawConfig.webSearchEnabled && rawConfig.webSearchApiKey
      ? {
          baseUrl: rawConfig.webSearchBaseUrl,
          apiKey: rawConfig.webSearchApiKey,
          model: rawConfig.webSearchModel,
        }
      : null,
    knowledge: knowledgeGateway,
  };
}
