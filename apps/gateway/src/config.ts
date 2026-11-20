import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { KnowledgeRuntimeConfig, MemoryRuntimeConfig } from "@nxcore/agent-runtime-pi";
// 阶段二：注册表只被用于「读取元数据」（env 名/默认 configKey），provider 文件本身
// 无副作用依赖，可安全进入 config 层（新增 provider 时 config 解析自动跟随注册表）。
import { SYNC_PROVIDERS } from "@nxcore/connectors-module/sync-providers/index.js";

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
    subagentSlidesMaxConcurrent: Type.Integer({ minimum: 1, maximum: 64 }),
    subagentDefaultMaxConcurrent: Type.Integer({ minimum: 1, maximum: 64 }),
    subagentBackgroundMaxConcurrent: Type.Integer({ minimum: 1, maximum: 64 }),
    subagentSlidesReasoning: Type.Optional(AiReasoningSchema),
    slidesDeckConcurrency: Type.Integer({ minimum: 1, maximum: 64 }),
    externalCallUserId: Type.String({ minLength: 1, maxLength: 200 }),
    externalCallWorkspaceId: Type.String({ minLength: 1, maxLength: 200 }),
    aiProvider: Type.String(),
    aiModel: Type.String(),
    aiBackgroundModel: Type.String(),
    aiTranscriptionModel: Type.String(),
    aiLiteModel: Type.String(),
    aiBaseUrl: Type.String(),
    aiApiKey: Type.String(),
    aiApi: AiApiSchema,
    aiMaxTokens: Type.Integer({ minimum: 1 }),
    aiBackgroundMaxTokens: Type.Integer({ minimum: 1 }),
    aiTranscriptionMaxTokens: Type.Integer({ minimum: 1 }),
    aiLiteMaxTokens: Type.Integer({ minimum: 1 }),
    diaryMaxTokens: Type.Integer({ minimum: 1 }),
    aiContextWindow: Type.Integer({ minimum: 1 }),
    aiTemperature: Type.Number({ minimum: 0, maximum: 2 }),
    aiReasoning: AiReasoningSchema,
    vlmBaseUrl: Type.String(),
    vlmApiKey: Type.String(),
    vlmModel: Type.String(),
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
    webSearchProvider: Type.Union([Type.Literal("dashscope"), Type.Literal("keenable")]),
    keenableApiKey: Type.String(),
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
    memoryRoomDeriveEnabled: Type.Boolean(),
    memoryRoomDeriveIntervalMs: Type.Integer({ minimum: 10_000 }),
    documentIndexBackfillEnabled: Type.Boolean(),
    documentIndexBackfillScanIntervalMs: Type.Integer({ minimum: 1_000 }),
    documentIndexBackfillQuietWindowMs: Type.Integer({ minimum: 0 }),
    documentIndexBackfillLlmEnabled: Type.Boolean(),
    documentIndexBackfillRescanMs: Type.Integer({ minimum: 0 }),
    documentIndexBackfillReadTriggerCooldownMs: Type.Integer({ minimum: 0 }),
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
    knowledgeRoomRelationMinScore: Type.Number({ exclusiveMinimum: 0 }),
    knowledgeEntityMergeAutoDice: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    knowledgeEntityMergeJudgeDice: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    knowledgeLlmBaseUrl: Type.String(),
    knowledgeLlmApiKey: Type.String(),
    knowledgeLlmModel: Type.String(),
    knowledgeEmbeddingModel: Type.String(),
    knowledgeEmbeddingBaseUrl: Type.String(),
    knowledgeEmbeddingApiKey: Type.String(),
    ingestFilterEnabled: Type.Boolean(),
    ingestFilterMode: Type.Union([Type.Literal("observe"), Type.Literal("enforce")]),
    ingestFilterConfidenceThreshold: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    ingestFilterBatchSize: Type.Integer({ minimum: 1, maximum: 20 }),
    ingestFilterBatchDelayMs: Type.Integer({ minimum: 0 }),
    ingestFilterExemptSourceKinds: Type.String(),
    ingestFilterToolsEnabled: Type.Boolean(),
    ingestFilterMaxToolCalls: Type.Integer({ minimum: 0, maximum: 128 }),
    ingestFilterRulesFile: Type.String(),
    ingestFilterRulesMaxBytes: Type.Integer({ minimum: 256, maximum: 65_536 }),
    ingestFilterInsightEnabled: Type.Boolean(),
    ingestFilterInsightIntervalMs: Type.Integer({ minimum: 60_000 }),
    notificationBridgeUrl: Type.String(),
    notificationBridgeToken: Type.String(),
    officeBridgeUrl: Type.String(),
    officeBridgeToken: Type.String(),
    agentDebugArchiveEnabled: Type.Boolean(),
    agentDebugArchiveDays: Type.Integer({ minimum: 1, maximum: 3_650 }),
    agentDebugArchiveRuns: Type.Integer({ minimum: 1, maximum: 100_000 }),
    agentDebugArchiveMaxMb: Type.Integer({ minimum: 64, maximum: 65_536 }),
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

/** 百炼（DashScope compatible-mode）联网搜索配置，注入 agent 的 web_search 工具。 */
export interface WebSearchConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Keenable 联网搜索；apiKey 为空时走免密钥 public 端点。 */
export interface KeenableWebSearchConfig {
  apiKey?: string;
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
  runtimeRole?: "user-facing" | "internal";
  skillsEnabled?: boolean;
  skillPrompts?: Record<string, string>;
  includeBashTool?: boolean;
  maxToolCallsPerRun?: number;
  /** 子 Agent 单条工具结果字符预算（JSON 感知截断）。 */
  maxToolResultChars?: number;
  /** 子 Agent run 内轮次级工具历史裁剪。 */
  runContextGuard?: { triggerTokens: number; keepRecentTurns: number };
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
  /** Minimum score for an automatically visible Room relation. */
  roomRelationMinScore: number;
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

/** agent 过滤器（ingest 第一级闸门）：无价值资料不进下游链路。 */
export interface IngestFilterConfig {
  enabled: boolean;
  /** observe = 只记 verdict 不拦截；enforce = 拦截。 */
  mode: "observe" | "enforce";
  /** 低于阈值的 filtered 判定放行（宁漏勿错杀）。 */
  confidenceThreshold: number;
  /** 去抖批大小（一次 agent run 批量判定条数上限）。 */
  batchSize: number;
  /** 去抖批等待窗口 ms。 */
  batchDelayMs: number;
  /** 豁免 sourceKind（用户手写/录音转写内容默认豁免，agent 不判生死）。 */
  exemptSourceKinds: string[];
  /** 只读 wiki/记忆工具总开关（false = 零工具纯 prompt，现行为）。 */
  toolsEnabled: boolean;
  /** 单 run 工具调用上限（过滤器专用 runtime 用）。 */
  maxToolCalls: number;
  /** 部署覆盖层规则文档路径。 */
  rulesFile: string;
  /** 单段注入截断上限（字节）。 */
  rulesMaxBytes: number;
  /** 洞察维护 job 开关。 */
  insightEnabled: boolean;
  /** 洞察刷新周期 ms。 */
  insightIntervalMs: number;
}

export interface OpenConnectorCliConfig {
  executable: string;
  baseUrl: string;
  runtimeToken?: string;
  /** 本地模式由 supervisor 生成；SaaS 模式由转发层管理（Seam4 授权流用）。 */
  adminToken?: string;
  configDirectory: string;
  dataDirectory: string;
}

export interface MemoryRoomDeriveConfig {
  enabled: boolean;
  intervalMs: number;
}

export interface DocumentIndexBackfillConfig {
  enabled: boolean;
  scanIntervalMs: number;
  quietWindowMs: number;
  llmEnabled: boolean;
  /** 全量重扫周期：游标走完一遍后隔这么久归零重走（复检覆盖宿主未动的文档）。 */
  rescanMs: number;
  /** 读取触发冷却：同一文档两次因被读取而入队的最小间隔。 */
  readTriggerCooldownMs: number;
}

/**
 * Agent 调试台历史归档（文件型，写入 dataDir/agent-debug/<source>/）。
 * 仅调试数据面：默认开启，`NXCORE_AGENT_DEBUG_ARCHIVE=0` 可整体关闭。
 */
export interface AgentDebugArchiveConfig {
  enabled: boolean;
  /** 保留天数；超过即清理最旧 run。 */
  retentionDays: number;
  /** 最多保留的 run 条数。 */
  maxRuns: number;
  /** 归档总字节上限。 */
  maxBytes: number;
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
  externalCallUserId?: string;
  externalCallWorkspaceId?: string;
  memory: MemoryRuntimeConfig | null;
  /** 新 L1 记忆自动绑定 Room（推导 worker）：缺省视为开启（enabled=true/300s），仅 gateway 侧消费。 */
  memoryRoomDerive?: MemoryRoomDeriveConfig;
  documentIndexBackfill?: DocumentIndexBackfillConfig;
  /** Agent 调试台历史归档；可选（旧测试/手写 config 对象缺省视为开启）。 */
  agentDebugArchive?: AgentDebugArchiveConfig;
  pi: PiRuntimeConfig | null;
  cursorCompletionPi: PiRuntimeConfig | null;
  knowledge: KnowledgeGatewayConfig | null;
  /** agent 过滤器（ingest 第一级闸门）配置；enabled=false 直通。 */
  ingestFilter: IngestFilterConfig;
  backgroundPi: PiRuntimeConfig | null;
  /** 转写总结专用档：独立于 background 换模型；model 为空＝未配置（回退 backgroundPi）。 */
  transcriptionSummaryPi: PiRuntimeConfig | null;
  /** 轻量模型档（main-lite）；model 为空＝未配置（lite 档隐藏）。 */
  litePi: PiRuntimeConfig | null;
  diaryMaxTokens?: number;
  subagents?: SubagentFrameworkConfig;
  /** agent MCP 配置文件绝对路径（设置页管理用）。 */
  mcpConfigPath: string;
  /** 百炼（DashScope）联网搜索工具配置；null 时 agent 不提供 web_search。 */
  webSearch: WebSearchConfig | null;
  /** NXCORE_WEB_SEARCH_PROVIDER=keenable 时由 Keenable 提供 web_search，不覆盖已保存的百炼配置。 */
  keenableWebSearch?: KeenableWebSearchConfig | null;
  vlm?: VlmConfig | null;
  asrInputDir: string;
  asr: AliyunAsrConfig | null;
  /** 链路A连接编排（P3 Nango 删除后仅剩编排自身配置；命名遗留 P4 清理）。 */
  nangoConnector?: {
    enabled: boolean;
    databasePath: string;
    pollingIntervalMs: number;
  };
  cliConnector?: OpenConnectorCliConfig | null;
  /** Agent 飞书导出用 lark-cli（发行包预装；桌面注入 NXCORE_LARK_CLI_PATH）。 */
  larkCli?: { executable: string } | null;
  /** Notion 导出用官方 ntn CLI（macOS 随包；桌面注入 NXCORE_NTN_CLI_PATH）。 */
  notionCli?: { executable: string } | null;
  /** 桌面文档资产本地桥（loopback）；飞书导出时本地图改写为该 URL 前缀由 lark-cli 下载。 */
  documentAssetBridgeUrl?: string | null;
  notificationBridge?: { baseUrl: string; token: string } | null;
  /** 桌面 Office 生成桥（loopback）：Agent 工具经它驱动隐藏 GenOffice view 生成 docx。 */
  officeBridge?: { baseUrl: string; token: string } | null;
}

export interface VlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SubagentFrameworkConfig {
  enabled: boolean;
  definitionsDir: string;
  runtimeDir: string;
  defaultTimeoutMs: number;
  /** 全池总上限：所有子代理并发 invocation 数之和，任何池都不得突破。 */
  maxConcurrent: number;
  /**
   * slides 系列子代理（逐页布局 / 逐页审阅）的专属并发上限。
   * 缺省沿用 `maxConcurrent`，即不分区——一册 15 页的 deck 需要 15 个页级
   * invocation 同时在飞，与交互链路共用一个 4~8 的窗口时，页级调用会互相排队。
   */
  slidesMaxConcurrent?: number;
  /** 非 slides 子代理（交互链路，如 context-room / doc-writer）的并发上限；缺省沿用 `maxConcurrent`。 */
  defaultMaxConcurrent?: number;
  /**
   * 影子/旁路作业（slides-editor 的 storyboard 阴影压缩）的并发上限。
   * 这类作业不参与交付，却会抢走页级布局的窗口——给它一个独立的小池。
   */
  backgroundMaxConcurrent?: number;
  /** 单册 deck 的页级并发上限（逐页取树 worker 数）；缺省 `DEFAULT_SLIDES_DECK_CONCURRENCY`。 */
  slidesDeckConcurrency?: number;
  /**
   * slides-* 子代理的推理档位覆盖（`NXCORE_SUBAGENT_SLIDES_REASONING`）。
   * 实测单页 165s 里 98% 是模型推理，想继续压只能动它；缺省不设＝沿用全局档位。
   * 拿来对同一份资料做 medium/low 的 A/B，不必改仓库里的 agent.yaml。
   */
  slidesReasoning?: AiReasoning;
}

/**
 * slides 池默认并发：一次 15 页 deck 需要 15 个页级 invocation 同时在飞。
 *
 * 取 16 而不是"越大越好"，是实测出来的：真实 key 并发阶梯（micro-payload，
 * 1/4/8/16/24/32）显示吞吐在 **16 见顶**（4.26 req/s），24 回落到 3.09，
 * 32 触发 provider 429（13/64 请求失败）。越过拐点只会更慢，还会丢请求。
 * 注：16 同时也是页级窗口（`slidesDeckConcurrency`）的默认值，二者对齐。
 */
export const DEFAULT_SLIDES_MAX_CONCURRENT = 16;
/** 非 slides 池默认并发（与改造前全局窗口一致，交互链路不受影响）。 */
export const DEFAULT_DEFAULT_MAX_CONCURRENT = 4;
/** 影子作业池默认并发：够它自己推进即可，绝不与页级布局抢窗口。 */
export const DEFAULT_BACKGROUND_MAX_CONCURRENT = 2;
/**
 * 单册 deck 页级并发默认值。
 * 必须 ≥ 典型页数（15）：页级窗口小于页数时，剩下的页要等第一波落定才开工，
 * 足足多出一整轮单页耗时（实测 P50 141s）。落页侧本身串行，故不必再往上加。
 */
export const DEFAULT_SLIDES_DECK_CONCURRENCY = 16;

/** Agent 调试台归档默认保留天数。 */
export const DEFAULT_AGENT_DEBUG_ARCHIVE_DAYS = 7;
/** Agent 调试台归档默认最多 run 条数。 */
export const DEFAULT_AGENT_DEBUG_ARCHIVE_RUNS = 2_000;
/** Agent 调试台归档默认总字节上限（MB）。 */
export const DEFAULT_AGENT_DEBUG_ARCHIVE_MAX_MB = 1_024;

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

/** 带范围校验的正整数配置：格式/范围错误都报 `Invalid <name>: <value>`。 */
function parseBoundedInteger(name: string, value: string, minimum: number, maximum: number): number {
  const parsed = parsePositiveInteger(name, value);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

/** 归档开关：缺省开启；1/true/on/yes 开，0/false/off/no 关，其余报错。 */
function parseArchiveEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return true;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  throw new Error(`Invalid NXCORE_AGENT_DEBUG_ARCHIVE: ${value}`);
}

/** Return the first non-empty environment value, allowing renamed variables to fall back safely. */
function firstEnvValue(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
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

const AI_REASONING_LEVELS: AiReasoning[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function parseAiReasoning(name: string, value: string | undefined): AiReasoning | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!AI_REASONING_LEVELS.includes(trimmed as AiReasoning)) {
    throw new Error(`Invalid ${name}: ${trimmed}`);
  }
  return trimmed as AiReasoning;
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
  // 私有网段（10.x/172.16-31.x/192.168.x/*.local）放行明文 HTTP：SaaS 转发层的
  // dev 内网地址（NXCORE_SAAS_API_URL）经 connector-mode 注入到本配置。
  const privateNetwork = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|.+\.local$)/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || privateNetwork))) {
    throw new Error(`Invalid ${name}: plain HTTP is only allowed for loopback or private network addresses`);
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

function defaultMigrationsDir(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, "drizzle"),
    resolve(moduleDirectory, "..", "drizzle"),
    resolve("drizzle"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** Agent definitions are project assets copied beside the packaged Gateway. */
export function bundledAgentDefinitionsDir(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, "agents"),
    resolve(moduleDirectory, "..", "..", "..", "agents"),
    resolve("agents"),
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
      env.NXCORE_SUBAGENT_MAX_CONCURRENT
        ?? String(DEFAULT_SLIDES_MAX_CONCURRENT + DEFAULT_DEFAULT_MAX_CONCURRENT + DEFAULT_BACKGROUND_MAX_CONCURRENT),
    ),
    subagentSlidesMaxConcurrent: parsePositiveInteger(
      "NXCORE_SUBAGENT_SLIDES_MAX_CONCURRENT",
      env.NXCORE_SUBAGENT_SLIDES_MAX_CONCURRENT ?? String(DEFAULT_SLIDES_MAX_CONCURRENT),
    ),
    subagentDefaultMaxConcurrent: parsePositiveInteger(
      "NXCORE_SUBAGENT_DEFAULT_MAX_CONCURRENT",
      env.NXCORE_SUBAGENT_DEFAULT_MAX_CONCURRENT ?? String(DEFAULT_DEFAULT_MAX_CONCURRENT),
    ),
    subagentBackgroundMaxConcurrent: parsePositiveInteger(
      "NXCORE_SUBAGENT_BACKGROUND_MAX_CONCURRENT",
      env.NXCORE_SUBAGENT_BACKGROUND_MAX_CONCURRENT ?? String(DEFAULT_BACKGROUND_MAX_CONCURRENT),
    ),
    subagentSlidesReasoning: parseAiReasoning(
      "NXCORE_SUBAGENT_SLIDES_REASONING",
      env.NXCORE_SUBAGENT_SLIDES_REASONING,
    ),
    slidesDeckConcurrency: parsePositiveInteger(
      "NXCORE_SLIDES_DECK_CONCURRENCY",
      env.NXCORE_SLIDES_DECK_CONCURRENCY ?? String(DEFAULT_SLIDES_DECK_CONCURRENCY),
    ),
    externalCallUserId: env.NXCORE_EXTERNAL_CALL_USER_ID?.trim() || "local-user",
    externalCallWorkspaceId: env.NXCORE_EXTERNAL_CALL_WORKSPACE_ID?.trim() || "local-workspace",
    aiProvider: env.NXCORE_AI_PROVIDER?.trim() ?? "",
    aiModel: env.NXCORE_AI_MODEL?.trim() ?? "",
    aiBackgroundModel: env.NXCORE_AI_BACKGROUND_MODEL?.trim() || env.NXCORE_AI_MODEL?.trim() || "",
    aiTranscriptionModel: env.NXCORE_AI_TRANSCRIPTION_MODEL?.trim() || "",
    aiBaseUrl: env.NXCORE_AI_BASE_URL?.trim() ?? "",
    aiApiKey: env.NXCORE_AI_API_KEY?.trim() ?? "",
    aiApi: env.NXCORE_AI_API ?? "openai-completions",
    aiMaxTokens: parsePositiveInteger("NXCORE_AI_MAX_TOKENS", env.NXCORE_AI_MAX_TOKENS ?? "8192"),
    aiBackgroundMaxTokens: parsePositiveInteger(
      "NXCORE_AI_BACKGROUND_MAX_TOKENS",
      env.NXCORE_AI_BACKGROUND_MAX_TOKENS ?? "8192",
    ),
    aiTranscriptionMaxTokens: parsePositiveInteger(
      "NXCORE_AI_TRANSCRIPTION_MAX_TOKENS",
      env.NXCORE_AI_TRANSCRIPTION_MAX_TOKENS ?? env.NXCORE_AI_BACKGROUND_MAX_TOKENS ?? "8192",
    ),
    aiLiteModel: env.NXCORE_AI_LITE_MODEL?.trim() ?? "",
    aiLiteMaxTokens: parsePositiveInteger(
      "NXCORE_AI_LITE_MAX_TOKENS",
      env.NXCORE_AI_LITE_MAX_TOKENS ?? env.NXCORE_AI_MAX_TOKENS ?? "8192",
    ),
    diaryMaxTokens: parsePositiveInteger(
      "NXCORE_DIARY_MAX_TOKENS",
      env.NXCORE_DIARY_MAX_TOKENS ?? "16384",
    ),
    aiContextWindow: parsePositiveInteger(
      "NXCORE_AI_CONTEXT_WINDOW",
      env.NXCORE_AI_CONTEXT_WINDOW ?? "128000",
    ),
    aiTemperature: parseTemperature(env.NXCORE_AI_TEMPERATURE ?? "0.3"),
    aiReasoning: env.NXCORE_AI_REASONING ?? "medium",
    vlmBaseUrl: env.NXCORE_VLM_BASE_URL?.trim() ?? "",
    vlmApiKey: env.NXCORE_VLM_API_KEY?.trim() ?? "",
    vlmModel: env.NXCORE_VLM_MODEL?.trim() ?? "",
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
    webSearchProvider: env.NXCORE_WEB_SEARCH_PROVIDER?.trim() || "dashscope",
    keenableApiKey: env.KEENABLE_API_KEY?.trim() ?? "",
    webSearchApiKey: env.NXCORE_WEB_SEARCH_API_KEY?.trim()
      ?? env.DASHSCOPE_API_KEY?.trim()
      ?? env.NXCORE_ASR_ALIYUN_API_KEY?.trim()
      ?? (env.NXCORE_AI_BASE_URL?.trim().toLowerCase().startsWith("https://dashscope.aliyuncs.com/")
        ? env.NXCORE_AI_API_KEY?.trim()
        : "")
      ?? "",
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
    nangoConnectorPollMs: parsePositiveInteger(
      "NXCORE_CONNECTOR_POLL_MS",
      env.NXCORE_CONNECTOR_POLL_MS?.trim() || "300000",
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
    memoryRoomDeriveEnabled: env.NXCORE_MEMORY_ROOM_DERIVE_ENABLED == null
      ? true
      : parseBoolean("NXCORE_MEMORY_ROOM_DERIVE_ENABLED", env.NXCORE_MEMORY_ROOM_DERIVE_ENABLED.trim()),
    memoryRoomDeriveIntervalMs: parsePositiveInteger(
      "NXCORE_MEMORY_ROOM_DERIVE_INTERVAL_MS",
      env.NXCORE_MEMORY_ROOM_DERIVE_INTERVAL_MS ?? "300000",
    ),
    documentIndexBackfillEnabled: env.NXCORE_DOCUMENT_INDEX_BACKFILL_ENABLED == null
      ? true
      : parseBoolean("NXCORE_DOCUMENT_INDEX_BACKFILL_ENABLED", env.NXCORE_DOCUMENT_INDEX_BACKFILL_ENABLED.trim()),
    documentIndexBackfillScanIntervalMs: parsePositiveInteger(
      "NXCORE_DOCUMENT_INDEX_BACKFILL_SCAN_INTERVAL_MS",
      env.NXCORE_DOCUMENT_INDEX_BACKFILL_SCAN_INTERVAL_MS ?? "60000",
    ),
    documentIndexBackfillQuietWindowMs: parsePositiveInteger(
      "NXCORE_DOCUMENT_INDEX_BACKFILL_QUIET_WINDOW_MS",
      env.NXCORE_DOCUMENT_INDEX_BACKFILL_QUIET_WINDOW_MS ?? "300000",
    ),
    documentIndexBackfillLlmEnabled: env.NXCORE_DOCUMENT_INDEX_BACKFILL_LLM_ENABLED == null
      ? true
      : parseBoolean("NXCORE_DOCUMENT_INDEX_BACKFILL_LLM_ENABLED", env.NXCORE_DOCUMENT_INDEX_BACKFILL_LLM_ENABLED.trim()),
    documentIndexBackfillRescanMs: parseNonNegativeInteger(
      "NXCORE_DOCUMENT_INDEX_BACKFILL_RESCAN_MS",
      env.NXCORE_DOCUMENT_INDEX_BACKFILL_RESCAN_MS ?? "86400000",
    ),
    documentIndexBackfillReadTriggerCooldownMs: parseNonNegativeInteger(
      "NXCORE_DOCUMENT_INDEX_BACKFILL_READ_TRIGGER_COOLDOWN_MS",
      env.NXCORE_DOCUMENT_INDEX_BACKFILL_READ_TRIGGER_COOLDOWN_MS ?? "1800000",
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
      env.NXCORE_KNOWLEDGE_ENTITY_PROMOTE_SCORE ?? "2.4",
    ),
    knowledgeEntityPromoteSources: parsePositiveInteger(
      "NXCORE_KNOWLEDGE_ENTITY_PROMOTE_SOURCES",
      env.NXCORE_KNOWLEDGE_ENTITY_PROMOTE_SOURCES ?? "3",
    ),
    knowledgeRoomRelationMinScore: parsePositiveNumber(
      "NXCORE_KNOWLEDGE_ROOM_RELATION_MIN_SCORE",
      env.NXCORE_KNOWLEDGE_ROOM_RELATION_MIN_SCORE ?? "1.0",
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
    ingestFilterEnabled: env.NXCORE_INGEST_FILTER_ENABLED == null
      ? false
      : parseBoolean("NXCORE_INGEST_FILTER_ENABLED", env.NXCORE_INGEST_FILTER_ENABLED.trim()),
    ingestFilterMode: env.NXCORE_INGEST_FILTER_MODE?.trim() === "enforce" ? "enforce" : "observe",
    ingestFilterConfidenceThreshold: parseFraction(
      "NXCORE_INGEST_FILTER_CONFIDENCE_THRESHOLD",
      env.NXCORE_INGEST_FILTER_CONFIDENCE_THRESHOLD ?? "0.7",
    ),
    ingestFilterBatchSize: parsePositiveInteger(
      "NXCORE_INGEST_FILTER_BATCH_SIZE",
      env.NXCORE_INGEST_FILTER_BATCH_SIZE ?? "5",
    ),
    ingestFilterBatchDelayMs: parseNonNegativeInteger(
      "NXCORE_INGEST_FILTER_BATCH_DELAY_MS",
      env.NXCORE_INGEST_FILTER_BATCH_DELAY_MS ?? "120000",
    ),
    ingestFilterExemptSourceKinds: env.NXCORE_INGEST_FILTER_EXEMPT_SOURCE_KINDS?.trim()
      ?? "everroom-doc,reality-event",
    ingestFilterToolsEnabled: env.NXCORE_INGEST_FILTER_TOOLS_ENABLED == null
      ? true
      : parseBoolean("NXCORE_INGEST_FILTER_TOOLS_ENABLED", env.NXCORE_INGEST_FILTER_TOOLS_ENABLED.trim()),
    ingestFilterMaxToolCalls: parsePositiveInteger(
      "NXCORE_INGEST_FILTER_MAX_TOOL_CALLS",
      env.NXCORE_INGEST_FILTER_MAX_TOOL_CALLS ?? "8",
    ),
    ingestFilterRulesFile: env.NXCORE_INGEST_FILTER_RULES_FILE?.trim()
      || join(dataDir, "ingest", "filter-rules.md"),
    ingestFilterRulesMaxBytes: parsePositiveInteger(
      "NXCORE_INGEST_FILTER_RULES_MAX_BYTES",
      env.NXCORE_INGEST_FILTER_RULES_MAX_BYTES ?? "2048",
    ),
    ingestFilterInsightEnabled: env.NXCORE_INGEST_FILTER_INSIGHT_ENABLED == null
      ? true
      : parseBoolean("NXCORE_INGEST_FILTER_INSIGHT_ENABLED", env.NXCORE_INGEST_FILTER_INSIGHT_ENABLED.trim()),
    ingestFilterInsightIntervalMs: parseNonNegativeInteger(
      "NXCORE_INGEST_FILTER_INSIGHT_INTERVAL_MS",
      env.NXCORE_INGEST_FILTER_INSIGHT_INTERVAL_MS ?? "3600000",
    ),
    notificationBridgeUrl: env.NXCORE_NOTIFICATION_BRIDGE_URL?.trim() ?? "",
    notificationBridgeToken: env.NXCORE_NOTIFICATION_BRIDGE_TOKEN?.trim() ?? "",
    officeBridgeUrl: env.NXCORE_OFFICE_BRIDGE_URL?.trim() ?? "",
    officeBridgeToken: env.NXCORE_OFFICE_BRIDGE_TOKEN?.trim() ?? "",
    agentDebugArchiveEnabled: parseArchiveEnabled(env.NXCORE_AGENT_DEBUG_ARCHIVE),
    agentDebugArchiveDays: parseBoundedInteger(
      "NXCORE_AGENT_DEBUG_ARCHIVE_DAYS",
      env.NXCORE_AGENT_DEBUG_ARCHIVE_DAYS ?? String(DEFAULT_AGENT_DEBUG_ARCHIVE_DAYS),
      1,
      3_650,
    ),
    agentDebugArchiveRuns: parseBoundedInteger(
      "NXCORE_AGENT_DEBUG_ARCHIVE_RUNS",
      env.NXCORE_AGENT_DEBUG_ARCHIVE_RUNS ?? String(DEFAULT_AGENT_DEBUG_ARCHIVE_RUNS),
      1,
      100_000,
    ),
    agentDebugArchiveMaxMb: parseBoundedInteger(
      "NXCORE_AGENT_DEBUG_ARCHIVE_MAX_MB",
      env.NXCORE_AGENT_DEBUG_ARCHIVE_MAX_MB ?? String(DEFAULT_AGENT_DEBUG_ARCHIVE_MAX_MB),
      64,
      65_536,
    ),
  };

  if (!Value.Check(RawConfigSchema, rawConfig)) {
    const details = [...Value.Errors(RawConfigSchema, rawConfig)]
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join("; ");
    throw new Error(`Invalid gateway configuration: ${details}`);
  }

  if (rawConfig.agentRuntime === "pi") {
    // AI 四要素全空 = 降级启动（等 runtime config 热应用，见 create-server 的
    // applyRuntimeConfig；packaged app 无 .env，本就是常态）；部分填写 = 配置
    // 事故，宁可早失败也不带半套配置起服务。
    const missing = [
      ["NXCORE_AI_PROVIDER", rawConfig.aiProvider],
      ["NXCORE_AI_MODEL", rawConfig.aiModel],
      ["NXCORE_AI_BASE_URL", rawConfig.aiBaseUrl],
      ["NXCORE_AI_API_KEY", rawConfig.aiApiKey],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0 && missing.length < 4) {
      throw new Error(`Pi runtime requires: ${missing.join(", ")}`);
    }
    if (missing.length === 0) validateAiEndpoint(rawConfig.aiBaseUrl);
  }

  if (rawConfig.vlmBaseUrl && rawConfig.vlmApiKey && rawConfig.vlmModel) {
    validateAiEndpoint(rawConfig.vlmBaseUrl, "NXCORE_VLM_BASE_URL");
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
  if (Boolean(rawConfig.notificationBridgeUrl)!==Boolean(rawConfig.notificationBridgeToken)) throw new Error("Notification bridge configuration requires URL and token together");
  if(rawConfig.notificationBridgeUrl){const u=new URL(rawConfig.notificationBridgeUrl);if(u.protocol!=="http:"||!["localhost","127.0.0.1","::1"].includes(u.hostname))throw new Error("NXCORE_NOTIFICATION_BRIDGE_URL must be a loopback HTTP endpoint");}
  if (Boolean(rawConfig.officeBridgeUrl)!==Boolean(rawConfig.officeBridgeToken)) throw new Error("Office bridge configuration requires URL and token together");
  if(rawConfig.officeBridgeUrl){const u=new URL(rawConfig.officeBridgeUrl);if(u.protocol!=="http:"||!["localhost","127.0.0.1","::1"].includes(u.hostname))throw new Error("NXCORE_OFFICE_BRIDGE_URL must be a loopback HTTP endpoint");}

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
        roomRelationMinScore: rawConfig.knowledgeRoomRelationMinScore,
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
    // 与 primary 同款降级规则：全空跳过（runtime config 兜底），部分填写报事故。
    const cursorMissing = ([
      ["NXCORE_CURSOR_COMPLETION_AI_PROVIDER", cursorCompletionPi.provider],
      ["NXCORE_CURSOR_COMPLETION_AI_MODEL", cursorCompletionPi.model],
      ["NXCORE_CURSOR_COMPLETION_AI_BASE_URL", cursorCompletionPi.baseUrl],
      ["NXCORE_CURSOR_COMPLETION_AI_API_KEY", cursorCompletionPi.apiKey],
    ] as const).filter(([, value]) => !value).map(([name]) => name);
    if (cursorMissing.length > 0 && cursorMissing.length < 4) {
      throw new Error(`Cursor completion Pi runtime requires: ${cursorMissing.join(", ")}`);
    }
    if (cursorMissing.length === 0) {
      validateAiEndpoint(cursorCompletionPi.baseUrl, "NXCORE_CURSOR_COMPLETION_AI_BASE_URL");
    }
  }
  if (rawConfig.vlmBaseUrl && rawConfig.vlmApiKey && rawConfig.vlmModel) {
    validateAiEndpoint(rawConfig.vlmBaseUrl, "NXCORE_VLM_BASE_URL");
  }
  const cliConnectorUrl = env.NXCORE_CLI_CONNECTOR_URL?.trim();
  if (cliConnectorUrl) validateConnectorEndpoint("NXCORE_CLI_CONNECTOR_URL", cliConnectorUrl);

  return {
    host: rawConfig.host,
    port: rawConfig.port,
    dataDir: rawConfig.dataDir,
    logLevel: rawConfig.logLevel,
    authToken: rawConfig.authToken,
    agentRuntime: rawConfig.agentRuntime,
    externalCallUserId: rawConfig.externalCallUserId,
    externalCallWorkspaceId: rawConfig.externalCallWorkspaceId,
    diaryMaxTokens: rawConfig.diaryMaxTokens,
    memory,
    memoryRoomDerive: {
      enabled: rawConfig.memoryRoomDeriveEnabled,
      intervalMs: rawConfig.memoryRoomDeriveIntervalMs,
    },
    documentIndexBackfill: {
      enabled: rawConfig.documentIndexBackfillEnabled,
      scanIntervalMs: rawConfig.documentIndexBackfillScanIntervalMs,
      quietWindowMs: rawConfig.documentIndexBackfillQuietWindowMs,
      llmEnabled: rawConfig.documentIndexBackfillLlmEnabled,
      rescanMs: rawConfig.documentIndexBackfillRescanMs,
      readTriggerCooldownMs: rawConfig.documentIndexBackfillReadTriggerCooldownMs,
    },
    // 调试数据面：默认开启；关闭时 create-server 不创建归档实例（store 不接收 archive）。
    agentDebugArchive: {
      enabled: rawConfig.agentDebugArchiveEnabled,
      retentionDays: rawConfig.agentDebugArchiveDays,
      maxRuns: rawConfig.agentDebugArchiveRuns,
      maxBytes: rawConfig.agentDebugArchiveMaxMb * 1_024 * 1_024,
    },
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
      // P3：Nango runtime 删除——链路A编排恒可用（executor 走 oo）。
      enabled: true,
      databasePath: join(dataDir,"database","connectors.sqlite"),
      pollingIntervalMs: rawConfig.nangoConnectorPollMs,
    },
    cliConnector: cliConnectorUrl
      ? {
          executable: env.NXCORE_CLI_CONNECTOR_CLI_PATH?.trim() || 'oo',
          baseUrl: cliConnectorUrl.replace(/\/$/, ''),
          ...(env.NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN?.trim()
            ? { runtimeToken: env.NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN.trim() }
            : {}),
          ...(env.NXCORE_CLI_CONNECTOR_ADMIN_TOKEN?.trim()
            ? { adminToken: env.NXCORE_CLI_CONNECTOR_ADMIN_TOKEN.trim() }
            : {}),
          configDirectory: env.NXCORE_CLI_CONNECTOR_CONFIG_DIR?.trim() || join(dataDir, 'open-connector', 'oo-config'),
          dataDirectory: env.NXCORE_CLI_CONNECTOR_DATA_DIR?.trim() || join(dataDir, 'open-connector', 'oo-data'),
        }
      : null,
    notificationBridge: rawConfig.notificationBridgeUrl
      ? { baseUrl: rawConfig.notificationBridgeUrl.replace(/\/$/, ""), token: rawConfig.notificationBridgeToken }
      : null,
    officeBridge: rawConfig.officeBridgeUrl
      ? { baseUrl: rawConfig.officeBridgeUrl.replace(/\/$/, ""), token: rawConfig.officeBridgeToken }
      : null,
    larkCli: {
      executable: firstEnvValue(env, "NXCORE_LARK_CLI_PATH")?.trim() || "lark-cli",
    },
    documentAssetBridgeUrl: firstEnvValue(env, "NXCORE_DOCUMENT_ASSET_BRIDGE_URL")?.trim() || null,
    notionCli: firstEnvValue(env, "NXCORE_NTN_CLI_PATH")?.trim()
      ? { executable: firstEnvValue(env, "NXCORE_NTN_CLI_PATH")!.trim() }
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
    // 转写总结档与 background 同为派生段（连接要素继承主模型），但 model 独立
    // 配置（NXCORE_AI_TRANSCRIPTION_MODEL / runtime config transcriptionSummary
    // 段）——后台任务换模型不再连带转写总结。恒建对象：runtime config 的 apply
    // 只能打补丁，model 空时靠 inheritPrimaryDefaults 凑四要素后由段内 model 覆盖。
    transcriptionSummaryPi: pi
      ? {
          ...pi,
          model: rawConfig.aiTranscriptionModel,
          maxTokens: rawConfig.aiTranscriptionMaxTokens,
        }
      : null,
    // lite 档恒从 pi 派生（连接要素继承主模型），model 空＝未配置：
    // 与 background 不同，model 不回落主模型——档位只在显式配置后出现。
    // 恒建对象（而非 model 空时 null）：runtime config 的 apply 只能打补丁，
    // null 无法被用户配置补齐（webSearch 同理在 create-server 直接构造）。
    litePi: pi
      ? {
          ...pi,
          model: rawConfig.aiLiteModel,
          maxTokens: rawConfig.aiLiteMaxTokens,
        }
      : null,
    // 布局代理（slides-layouter）直接用主模型：主模型已具备视觉能力，自审直接看
    // 渲染图，不再需要独立的多模态视觉档（vlm 槽仍供给 perception / 视觉复检等
    // 其他链路，见 config.vlm）。
    subagents: {
      enabled: rawConfig.subagentsEnabled,
      definitionsDir: resolve(rawConfig.subagentsDir || bundledAgentDefinitionsDir()),
      runtimeDir: join(dataDir, "agent", "subagents"),
      defaultTimeoutMs: rawConfig.subagentTimeoutMs,
      maxConcurrent: rawConfig.subagentMaxConcurrent,
      slidesMaxConcurrent: rawConfig.subagentSlidesMaxConcurrent,
      defaultMaxConcurrent: rawConfig.subagentDefaultMaxConcurrent,
      backgroundMaxConcurrent: rawConfig.subagentBackgroundMaxConcurrent,
      slidesDeckConcurrency: rawConfig.slidesDeckConcurrency,
      ...(rawConfig.subagentSlidesReasoning === undefined
        ? {}
        : { slidesReasoning: rawConfig.subagentSlidesReasoning }),
    },
    mcpConfigPath,
    webSearch: pi && rawConfig.webSearchEnabled && rawConfig.webSearchApiKey
      ? {
          baseUrl: rawConfig.webSearchBaseUrl,
          apiKey: rawConfig.webSearchApiKey,
          model: rawConfig.webSearchModel,
        }
      : null,
    keenableWebSearch: pi && rawConfig.webSearchEnabled && rawConfig.webSearchProvider === "keenable"
      ? (rawConfig.keenableApiKey ? { apiKey: rawConfig.keenableApiKey } : {})
      : null,
    vlm: rawConfig.vlmBaseUrl && rawConfig.vlmApiKey && rawConfig.vlmModel
      ? { baseUrl: rawConfig.vlmBaseUrl, apiKey: rawConfig.vlmApiKey, model: rawConfig.vlmModel }
      : null,
    knowledge: knowledgeGateway,
    ingestFilter: {
      enabled: rawConfig.ingestFilterEnabled,
      mode: rawConfig.ingestFilterMode,
      confidenceThreshold: rawConfig.ingestFilterConfidenceThreshold,
      batchSize: Math.min(rawConfig.ingestFilterBatchSize, 20),
      batchDelayMs: rawConfig.ingestFilterBatchDelayMs,
      exemptSourceKinds: rawConfig.ingestFilterExemptSourceKinds
        .split(",")
        .map((kind) => kind.trim())
        .filter(Boolean),
      toolsEnabled: rawConfig.ingestFilterToolsEnabled,
      maxToolCalls: rawConfig.ingestFilterMaxToolCalls,
      rulesFile: rawConfig.ingestFilterRulesFile,
      rulesMaxBytes: rawConfig.ingestFilterRulesMaxBytes,
      insightEnabled: rawConfig.ingestFilterInsightEnabled,
      insightIntervalMs: rawConfig.ingestFilterInsightIntervalMs,
    },
  };
}
