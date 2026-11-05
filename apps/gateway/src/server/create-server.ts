import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { LogController } from "fastify";
import type { FastifyError } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  bundledAgentDefinitionsDir,
  DEFAULT_BACKGROUND_MAX_CONCURRENT,
  DEFAULT_DEFAULT_MAX_CONCURRENT,
  DEFAULT_SLIDES_DECK_CONCURRENCY,
  DEFAULT_SLIDES_MAX_CONCURRENT,
  type GatewayConfig,
} from "../config.js";
import { createDatabase } from "../infrastructure/database/client.js";
import { agentEvents, agentMessages, agentSessions, agentWorkspaces, gatewayMetadata } from "../infrastructure/database/schema.js";
import { asc, eq, inArray } from "drizzle-orm";
import { channelAgentIdFromAgentId } from "@nxcore/agent-contract";
import { systemRoutes } from "../modules/system/routes.js";
import { AgentEventBroker } from "../modules/agent/event-broker.js";
import { agentRoutes } from "../modules/agent/routes.js";
import { SpaceCacheManager } from "../modules/workspace-layout/cache.js";
import { SpaceAgentRoots } from "../modules/workspace-layout/agent-root.js";
import { SpaceMemoryRoots } from "../modules/workspace-layout/memory-root.js";
import { SpaceLibraryWriter } from "../modules/workspace-layout/library.js";
import { workspaceLayoutRoutes } from "../modules/workspace-layout/routes.js";
import { WorkspaceLayoutService } from "../modules/workspace-layout/service.js";
import { McpConfigManager, mcpRoutes } from "../modules/agent/mcp-routes.js";
import {
  ChannelMcpHost,
} from "../modules/agent/channel-mcp-host.js";
import { channelMcpRoutes } from "../modules/agent/channel-mcp-routes.js";
import { AgentAccessMcpHost } from "../modules/agent-access/mcp-host.js";
import { agentAccessMcpRoutes } from "../modules/agent-access/mcp-routes.js";
import { agentAccessRoutes } from "../modules/agent-access/routes.js";
import { AgentAccessService } from "../modules/agent-access/service.js";
import { createAgentAccessTools } from "../modules/agent-access/tools.js";
import { AgentService } from "../modules/agent/service.js";
import { DocumentEventBroker } from "../modules/documents/event-broker.js";
import { DocumentMcpHost } from "../modules/documents/mcp-host.js";
import { DocumentOperationService } from "../modules/documents/operations/service.js";
import { documentMcpRoutes } from "../modules/documents/mcp-routes.js";
import { NotificationBridgeClient } from "../modules/notifications/bridge-client.js";
import { NotificationMcpHost } from "../modules/notifications/mcp-host.js";
import { notificationMcpRoutes } from "../modules/notifications/mcp-routes.js";
import { createNotificationPiTools } from "../modules/notifications/pi-tools.js";
import { documentRoutes } from "../modules/documents/routes.js";
import { documentOperationRoutes } from "../modules/documents/operations/routes.js";
import { DocumentService } from "../modules/documents/service.js";
import { DocumentCommentService } from "../modules/documents/comments.js";
import { documentCommentRoutes } from "../modules/documents/comment-routes.js";
import { documentOverviewRoutes } from "../modules/documents/overview-routes.js";
import { documentSectionPreviewRoutes } from "../modules/documents/section-preview-routes.js";
import { createBuiltinDocumentCapabilityRegistry } from "../modules/documents/capabilities/builtins.js";
import { SlidesVisualReviewer } from "../modules/slides-visual-review/review.js";
import { OfficeBridgeClient } from "../modules/documents/capabilities/office-bridge-client.js";
import type { DocumentIllustrationPorts } from "../modules/documents/capabilities/office-plugin.js";
import { ExternalDocumentProjectionService } from "../modules/documents/external-projections/service.js";
import { externalDocumentProjectionRoutes } from "../modules/documents/external-projections/routes.js";
import { DocumentImportService } from "../modules/documents/import/service.js";
import { documentImportRoutes } from "../modules/documents/import/routes.js";
import { DocumentBatchImportService } from "../modules/documents/import/batch-service.js";
import { documentImportBatchRoutes } from "../modules/documents/import/batch-routes.js";
import { AgentDocumentExportService } from "../modules/documents/agent-export/service.js";
import { agentDocumentExportRoutes } from "../modules/documents/agent-export/routes.js";
import { createDocumentExportPiTools } from "../modules/documents/agent-export/tools.js";
import { createDocumentImportPiTools } from "../modules/documents/import/tools.js";
import {
  createAgentResolver,
  createDocumentOverviewRuntime,
  createConversationSuggestionRuntime,
  createIndexBackfillRuntime,
  createMemoryRuntimeResolver,
  createSessionTitleRuntime,
  createVersionSummaryRuntime,
  isPiRuntimeConfigured,
  registerLiteAgentIfMissing,
  registerModelTierAgents,
  registerPrimaryAgent,
  type AgentRuntimeIntegrationOptions,
} from "../modules/agent/runtime-factory.js";
import { BUILTIN_AGENT_IDS } from "../modules/agent/resolver.js";
import { registerWebSearchAgentIfMissing } from "../modules/agent/runtime-factory.js";
import { connectorSessionRoutes } from "../modules/connectors/session-routes.js";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import { DocumentServiceError } from "../modules/documents/errors.js";
import { createDocumentPiTools } from "../modules/documents/pi-tools.js";
import { createWebSearchPiTools } from "../modules/agent/web-search-tools.js";
import { createSlidesPlannerAgentTools, createSlidesBuilderAgentTools, createSlidesLayouterAgentTools, createSlidesTreeResultValidator } from "../modules/subagents/slides-agent-tools.js";
import { DocumentIndexBackfillWorker } from "../modules/documents/index-backfill/worker.js";
import { DocumentIndexBackfillReadTrigger } from "../modules/documents/index-backfill/read-trigger.js";
import { IndexBackfillLlm } from "../modules/documents/index-backfill/llm.js";
import { DataMigrationService } from "../modules/data-migrations/service.js";
import { SearchService } from "../modules/search/service.js";
import { MemoryService } from "../modules/memory/service.js";
import { MemoryDistiller, type CapturedSegment, type DistillCursor, type DistillSignals } from "../modules/memory/distill.js";
import { MemoryModelUnavailableError, isMemoryModelUnavailable } from "../modules/memory/model-errors.js";
import { composeWorkspaceInsight as composeWorkspaceInsightViaLlm } from "../modules/workspace-insight/composer.js";
import { workspaceInsightRoutes } from "../modules/workspace-insight/routes.js";
import { WorkspaceInsightService } from "../modules/workspace-insight/service.js";
import {
  createUserProfilePromptCache,
  MemoryProfileAggregator,
} from "../modules/memory/profile.js";
import { invokeRuntime } from "../modules/agent/invoke.js";
import { memoryRoutes } from "../modules/memory/routes.js";
import {
  composeJournal,
  JournalScheduler,
  JournalService,
  journalRoutes,
  MEMORY_LIST_LIMIT as JOURNAL_MEMORY_LIST_LIMIT,
} from "../modules/journal/index.js";
import {
  createPlanPiTools,
  PlanError,
  PlanLeaseReaper,
  PlanService,
  planMcpRoutes,
  planRoutes,
  PlanStreamHub,
} from "../modules/plan/index.js";
import type { PlanDispatchInput, PlanDispatchResult } from "../modules/plan/index.js";
import { workspaceActivityRoutes, WorkspaceActivityService } from "../modules/workspace-activity/index.js";
import { SearchBackfill } from "../modules/search/backfill.js";
import { searchRoutes } from "../modules/search/routes.js";
import { dataMigrationRoutes } from "../modules/data-migrations/routes.js";
import { filesRoutes } from "../modules/files/routes.js";
import { SlideImageStore } from "../modules/slides-style/image-store.js";
import { slideImageRoutes } from "../modules/slides-style/image-routes.js";
import { FilesService } from "../modules/files/service.js";
import { createFileReadPiTool, createFileSearchPiTool } from "../modules/files/pi-tools.js";
import { createLibraryBrowsePiTool } from "../modules/files/library-browse.js";
import { DocumentListSyncWorker } from "../modules/documents/import/list-sync-worker.js";
import { DocumentHistoryBackfillWorker } from "../modules/documents/index-backfill/history-worker.js";
import { connectorRoutes } from "@nxcore/connectors-module/routes.js";
import { ConnectorQueryService, FilteredConnectorRuntime, HttpConnectorActionRuntime } from "@nxcore/connectors-module/query/index.js";
import { ConnectorMcpHost } from "../modules/connectors/connector-mcp-host.js";
import { ConnectorMcpServer } from "../modules/connectors/connector-mcp-server.js";
import { createConnectorContextResolver } from "../modules/connectors/connector-context.js";
import { ConnectorConnectionCatalog } from "@nxcore/connectors-module/connection-runtime.js";
import { createConnectorTombstoneStore } from "../modules/connectors/tombstone-store.js";
import { cleanupLegacyConnectorData } from "../modules/connectors/cleanup.js";
import { ConversationSuggestionService } from "../modules/processing/conversation-suggestion.js";
import { processingRoutes } from "../modules/processing/routes.js";
import { AutoSessionTitles } from "../modules/processing/auto-session-title.js";
import { SessionTitleService } from "../modules/processing/session-title.js";
import { DocumentUnderstandingService } from "../modules/document-understanding/service.js";
import { documentUnderstandingRoutes } from "../modules/document-understanding/routes.js";
import {
  createDocumentAnalysisResultValidator,
  createDocumentUnderstandingTools,
} from "../modules/document-understanding/tools.js";
import { AgentSchedulerService } from "../modules/agent-scheduler/service.js";
import { agentSchedulerRoutes } from "../modules/agent-scheduler/routes.js";
import { agentSchedulerMcpRoutes } from "../modules/agent-scheduler/mcp-routes.js";
import { auth } from "./auth.js";
import { createGatewayLogger } from "./logger.js";
import "./types.js";
import { OpenConnectorAuthorizationService } from "@nxcore/connectors-module/open-connector-authorization.js";
import { SubagentRegistry } from "../modules/subagents/registry.js";
import { SubagentRuntimeManager } from "../modules/subagents/runtime-manager.js";
import { SubagentOrchestrator } from "../modules/subagents/orchestrator.js";
import { SlidesProgressTracker } from "../modules/subagents/slides-progress-tracker.js";
import { SlidesGenerationCheckpointStore } from "../modules/subagents/slides-generation-checkpoints.js";
import { createSubagentPiTools, inferMaterialSourcesFromReads } from "../modules/subagents/tools.js";
import { LocalAgentRuntimeRegistry } from "../modules/local-agents/runtime-registry.js";
import { subagentRoutes } from "../modules/subagents/routes.js";
import { AgentSkillStateStore } from "../modules/skills/state-store.js";
import { UserSkillStore } from "../modules/skills/user-skills.js";
import { SkillService } from "../modules/skills/service.js";
import { skillRoutes } from "../modules/skills/routes.js";
import { AgentStatusService } from "../modules/agent/status-service.js";
import { AgentDebugService } from "../modules/agent-debug/service.js";
import { agentDebugRoutes } from "../modules/agent-debug/routes.js";
import { AgentDebugUsageStore } from "../modules/agent-debug/usage-store.js";
import { createReferencedAgentConversationTools } from "../modules/agent/reference-tools.js";
import { createLocalAgentDispatchTools } from "../modules/local-agents/dispatch-tools.js";
import { LocalAgentDispatchStore } from "../modules/local-agents/dispatch-store.js";
import type { LocalAgentDispatchSource } from "../modules/local-agents/dispatch-tools.js";
import { RuntimeConfigManager } from "../runtime-config.js";
import { runtimeConfigRoutes } from "../modules/runtime-config/routes.js";
import { AiRelaySessionStore, relayPathPrefix } from "../modules/ai-relay/session.js";
import { SlidesStyleImageGenerator } from "../modules/slides-style/image-gen.js";
import { SlidesStyleSessionStore } from "../modules/slides-style/style-session.js";
import { SlidesPageImageSessionStore } from "../modules/subagents/slides-page-images-store.js";
import { SlidesStoryboardStore } from "../modules/subagents/slides-storyboards-store.js";
import { SlidesPageImageRunner } from "../modules/subagents/slides-page-images-runner.js";
import { slidesPageImagesRoutes } from "../modules/slides/page-images-routes.js";
import { ThesisFormatService } from "../modules/thesis-format/service.js";
import { thesisFormatRoutes } from "../modules/thesis-format/routes.js";
import type { SlidesStyleStageDeps } from "../modules/subagents/slides-style-stage.js";
import { aiRelayRoutes } from "../modules/ai-relay/routes.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { OpenAiCompatibleVlmClient } from "../modules/vision/vlm-client.js";
import { isPrimaryConfigured as isRuntimePrimaryConfigured } from "../modules/runtime-config/validate.js";
import { DEFAULT_SECRET_STORE_MASTER_KEY, SecretStore } from "../security/secret-store.js";
import { redactSecrets, redactText } from "../security/secret-redaction.js";
import { ExternalCallBudgetService } from "../modules/external-calls/service.js";
import { externalCallRoutes } from "../modules/external-calls/routes.js";

function applyRuntimeConfig(config: GatewayConfig, runtime: RuntimeConfig): void {
  // runtime config（尤其默认文件）里的 "" 是「未配置」占位，不是「清空」指令：
  // 空串直接覆盖会把 env 兜底打掉。
  const apply = (target: Record<string, unknown> | null | undefined, source: unknown) => {
    if (!target || !source || typeof source !== "object") return;
    const value = source as Record<string, unknown>;
    for (const key of ["provider", "model", "baseUrl", "api", "apiKey", "maxTokens", "contextWindow", "temperature", "reasoning"]) {
      if (value[key] !== undefined && value[key] !== "") target[key] = value[key];
    }
  };
  apply(config.pi as unknown as Record<string, unknown> | null, runtime.primary);
  apply(config.backgroundPi as unknown as Record<string, unknown> | null, runtime.background);
  apply(config.litePi as unknown as Record<string, unknown> | null, runtime.lite);
  apply(config.cursorCompletionPi as unknown as Record<string, unknown> | null, runtime.cursorCompletion);
  // background/cursorCompletion 对齐 env 构建语义（config.ts 的 {...pi} 拷贝）：
  // runtime 段只携带部分覆盖（默认配置里这两段仅预置 api）时，四要素缺失项
  // 继承 primary——否则 patch 永远凑不齐 isPiRuntimeConfigured，后台转写总结
  // runtime 一直停留在未配置占位，任务永远 runtime_config_not_ready。
  inheritPrimaryDefaults(config.pi, config.backgroundPi);
  inheritPrimaryDefaults(config.pi, config.cursorCompletionPi);
  // lite 档连接三要素（provider/baseUrl/apiKey）缺省继承 primary，但 model
  // 不继承——model 空＝未配置 lite＝档位隐藏，回落主模型会冒充轻量档。
  if (config.pi && config.litePi) {
    for (const key of ["provider", "baseUrl", "apiKey"] as const) {
      if (!config.litePi[key] && config.pi[key]) {
        (config.litePi as unknown as Record<string, unknown>)[key] = config.pi[key];
      }
    }
  }
  // webSearch：boot 时 config.webSearch 仅由 env 构造（config.ts 的
  // NXCORE_WEB_SEARCH_API_KEY 门），env 未配时为 null 且 apply 无法从 null
  // 构造——runtime 四要素齐全时直接构造，让云端下发的搜索配置真正生效。
  const runtimeWebSearch = runtime.webSearch as Record<string, unknown> | undefined;
  const webSearchText = (key: string): string =>
    runtimeWebSearch && typeof runtimeWebSearch[key] === "string" ? (runtimeWebSearch[key] as string).trim() : "";
  if (webSearchText("baseUrl") && webSearchText("apiKey") && webSearchText("model")) {
    config.webSearch = {
      baseUrl: webSearchText("baseUrl"),
      apiKey: webSearchText("apiKey"),
      model: webSearchText("model"),
    };
  } else config.webSearch = null;
  // VLM：runtime 三字段齐全可直接构造（否则 env 没配时 runtime.vlm 是死配置）；
  // 不齐全时保持补丁行为——env 已配的键由 apply 补，缺的键沿用 env 值。
  const runtimeVlm = runtime.vlm as Record<string, unknown> | undefined;
  const vlmText = (key: string): string =>
    runtimeVlm && typeof runtimeVlm[key] === "string" ? (runtimeVlm[key] as string).trim() : "";
  if (vlmText("baseUrl") && vlmText("apiKey") && vlmText("model")) {
    config.vlm = { baseUrl: vlmText("baseUrl"), apiKey: vlmText("apiKey"), model: vlmText("model") };
  } else {
    apply(config.vlm as unknown as Record<string, unknown> | null, runtime.vlm);
  }
  // 审页档（slides-reviewer）同样吃 vlm 槽：SaaS 套餐下发的视觉模型（或内置
  // 默认/BYOK）直接作为审页模型。vlm 槽自带连接（中转重写或 BYOK 继承）时一并
  // 补齐；空连接时审页档保留从 pi 继承的连接。model 未变化时 apply 不触碰。
  apply(config.slidesReviewerPi as unknown as Record<string, unknown> | null, runtime.vlm);
}

/**
 * 派生段（background/cursorCompletion）四要素缺省继承 primary：与 env 构建
 * 语义（config.ts 的 backgroundPi = {...pi, model: 背景模型}）一致。runtime
 * config 的派生段只带部分覆盖（默认配置仅预置 api）时靠 patch 凑不齐
 * isPiRuntimeConfigured，派生 runtime 会永远停留在 UnconfiguredAgentRuntime。
 */
function inheritPrimaryDefaults(
  primary: GatewayConfig["pi"],
  target: GatewayConfig["pi"],
): void {
  if (!primary || !target) return;
  for (const key of ["provider", "model", "baseUrl", "apiKey"] as const) {
    if (!target[key] && primary[key]) target[key] = primary[key];
  }
}

function createVlmProvider(config: GatewayConfig): OpenAiCompatibleVlmClient | null {
  const vlm = config.vlm;
  return vlm && vlm.baseUrl && vlm.apiKey && vlm.model
    ? new OpenAiCompatibleVlmClient({ baseUrl: vlm.baseUrl, apiKey: vlm.apiKey, model: vlm.model })
    : null;
}

function swaggerAssetsDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "static"),
    resolve(moduleDirectory, "..", "..", "node_modules", "@fastify", "swagger-ui", "static"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

// AI 中转余额类失败（new-api insufficient_user_quota / OpenAI insufficient quota
// / 预扣费额度失败）。这类错误以普通 Error 形态从 agent runtime 冒出，若不识别
// 会落进 500 兜底，桌面端只会看到笼统的 "An internal gateway error occurred"。
export function isAiQuotaError(message: string): boolean {
  return /insufficient_user_quota|insufficient quota|exceeded your current quota|预扣费额度失败|额度不足/i.test(message);
}

export async function createServer(config: GatewayConfig) {
  const gatewayLogger = await createGatewayLogger(config.dataDir, config.logLevel);
  // Fastify emits one INFO line for both sides of every request. Keep those
  // access logs disabled by default; warn/error paths still reach the logger.
  const gatewayHttpLogLevel = process.env.NXCORE_GATEWAY_HTTP_LOG_LEVEL?.trim().toLowerCase() ?? "warn";
  const disableRequestLogging = gatewayHttpLogLevel !== "debug" && gatewayHttpLogLevel !== "info";
  const app = Fastify({
    loggerInstance: gatewayLogger.logger,
    logController: new LogController({ disableRequestLogging }),
    routerOptions: {
      // 路径参数上限放宽到 500：外部来源的引用型 id（caller_ref 等）URL 编码后
      // 会超 Fastify 默认 100 上限被拒。500 覆盖最长组合。
      maxParamLength: 500,
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const { db, sqlite } = createDatabase(config.databasePath, config.migrationsDir);
  app.decorate("db", db);
  const secretStore = new SecretStore(
    join(config.dataDir, "security", "credentials.enc"),
    // 空白（.env.example 复制来的空值）视为未设置，回落到内置默认。
    process.env.NXCORE_SECRET_STORE_KEY?.trim() || DEFAULT_SECRET_STORE_MASTER_KEY,
  );
  const mcpConfigManager = new McpConfigManager(config, secretStore);
  const externalCalls = new ExternalCallBudgetService(sqlite, undefined, {
    userId: config.externalCallUserId ?? "local-user",
    workspaceId: config.externalCallWorkspaceId ?? "local-workspace",
  });
  const aiRelaySessions = new AiRelaySessionStore();
  const runtimeConfigManager = new RuntimeConfigManager(db, secretStore, undefined, config.webSearch
    ? { provider: "openai-compatible", api: "openai-completions", ...config.webSearch }
    : null, () => {
      const session = aiRelaySessions.current();
      if (!session) return null;
      // 槽位重写目标的 API 前缀由会话 baseUrl 决定（推导见 relayPathPrefix，
      // 与会话续期短路共用）。旧槽位路径不参与。
      return { proxyOrigin: session.proxyOrigin, token: config.authToken, pathPrefix: relayPathPrefix(session.baseUrl), models: session.models ?? undefined };
    });
  const initialRuntimeSnapshot = runtimeConfigManager.snapshot();
  applyRuntimeConfig(config, initialRuntimeSnapshot.config);
  const redactedRuntimeSnapshot = runtimeConfigManager.snapshot(true);
  app.log.info({
    event: "runtime_config.selected",
    source: initialRuntimeSnapshot.selectedSource,
    availableSources: initialRuntimeSnapshot.availableSources,
    configVersion: initialRuntimeSnapshot.configVersion,
    primaryConfigured: isRuntimePrimaryConfigured(initialRuntimeSnapshot.config),
    configJson: JSON.stringify(redactedRuntimeSnapshot.config),
  }, "runtime config selected");
  // 连接器：Agent 即席查询。没有 scope / run / 游标 / 定时同步；
  // 连接事实源是 oo，本地只叠加「已断开」墓碑。
  config.cliConnector ??= {
    executable: "oo",
    baseUrl: "",
    configDirectory: resolve(config.dataDir, "open-connector", "oo-config"),
    dataDirectory: resolve(config.dataDir, "open-connector", "oo-data"),
  };
  const removedLegacyConnectorFiles = cleanupLegacyConnectorData(config.dataDir);
  if (removedLegacyConnectorFiles.length > 0) {
    app.log.info({ removed: removedLegacyConnectorFiles }, "legacy connector sync artifacts removed");
  }
  const connectorActionRuntime = new HttpConnectorActionRuntime(config.cliConnector);
  const connectorTombstones = createConnectorTombstoneStore(db, "local-user");
  const connectorRuntime = new FilteredConnectorRuntime(connectorActionRuntime, connectorTombstones);
  const connectorQueryService = new ConnectorQueryService(connectorRuntime);
  const connectorCatalog = new ConnectorConnectionCatalog(connectorActionRuntime, connectorTombstones);
  const connectorAuthorization = config.cliConnector.adminToken
    ? new OpenConnectorAuthorizationService(config.cliConnector, connectorCatalog)
    : undefined;
  const connectorMcpHost = new ConnectorMcpHost({
    query: connectorQueryService,
    session: () =>
      config.cliConnector?.baseUrl
        ? {
            baseUrl: config.cliConnector.baseUrl,
            ...(config.cliConnector.runtimeToken ? { runtimeToken: config.cliConnector.runtimeToken } : {}),
          }
        : null,
    logger: app.log,
    disconnected: (service, connectionName) => connectorTombstones.has(service, connectionName),
  });
  const connectorMcpServer = new ConnectorMcpServer(connectorMcpHost, { logger: app.log });
  const connectorMcp = await connectorMcpServer.start().catch((error: unknown) => {
    app.log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "connector MCP server failed to start; connector tools stay disabled",
    );
    return null;
  });

  // /v1/runtime-config/secrets 是唯一允许真密钥出站的端点：主进程派生托管
  // 子进程 env 用（token 鉴权，token 只在主进程）；若在此脱敏，子进程会拿
  // "[REDACTED]" 当 key 起服务并静默 401。其余响应一律按键名/注册密钥脱敏。
  // agent-access 的连接签发/轮换/安装代写同为有意出站的密钥面（连接 token
  // 仅创建时返回一次；三端点都走全局 bearer，install 另需 token 匹配）。
  app.addHook("preSerialization", async (request, _reply, payload) => {
    if (request.routeOptions.url === "/v1/runtime-config/secrets") return payload;
    if (request.routeOptions.url === "/v1/agent-access/connections"
      || request.routeOptions.url === "/v1/agent-access/connections/:id/token"
      || request.routeOptions.url === "/v1/agent-access/connections/:id/install/:target") {
      return payload;
    }
    return redactSecrets(payload);
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "request failed");
    if (error instanceof DocumentServiceError) {
      await reply.code(error.statusCode).send({
        error: error.code,
        message: redactText(error.message),
        ...error.details,
        requestId: request.id,
      });
      return;
    }
    // AI 中转余额耗尽：给出结构化 402，桌面端据此提示"额度不足"而不是笼统 500。
    if (isAiQuotaError(error.message)) {
      await reply.code(402).send({
        error: "ai_quota_exhausted",
        message: "AI relay account is out of quota",
        requestId: request.id,
      });
      return;
    }
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    await reply.code(statusCode).send({
      error: statusCode === 500 ? "internal_error" : "request_error",
      message: statusCode === 500 ? "An internal gateway error occurred" : redactText(error.message),
      requestId: request.id,
    });
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "NxCore Gateway API",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs", baseDir: swaggerAssetsDirectory() });
  await app.register(websocket);
  await app.register(auth, { token: config.authToken });
  await app.register(systemRoutes);
  await app.register(runtimeConfigRoutes(runtimeConfigManager));
  await app.register(aiRelayRoutes({ sessions: aiRelaySessions, runtimeConfigManager }));
  const documentEventBroker = new DocumentEventBroker();
  const documentOperationService = new DocumentOperationService(db, documentEventBroker);
  const documentService = new DocumentService(db, documentEventBroker,
    undefined, undefined, (documentId, currentVersion) => (
    documentOperationService.prepareExternalVersionAdvance(documentId, currentVersion)
  ), (error, documentId, currentVersion) => {
    app.log.warn({ err: error, documentId, currentVersion }, "document after-commit observer failed");
  });
  // dispatch 期软租约的崩溃残留清扫（agent-modification:* 不属于任何 Operation）。
  const orphanLeases = documentService.clearOrphanModificationLeases();
  if (orphanLeases > 0) {
    app.log.info({ orphanLeases }, "agent modification leases cleared after restart");
  }
  const recoveredDocumentOperations = documentOperationService.recoverInterrupted();
  if (recoveredDocumentOperations > 0) {
    app.log.info({ recoveredDocumentOperations }, "interrupted document operations recovered");
  }
  const documentOperationExpiryTimer = setInterval(() => {
    const expiredDocumentOperations = documentOperationService.expire();
    if (expiredDocumentOperations > 0) {
      app.log.info({ expiredDocumentOperations }, "document operations expired");
    }
  }, 30_000);
  documentOperationExpiryTimer.unref();
  // 外部文档导入（飞书 lark-cli / Notion OpenConnector，只读）与 Agent 一次性
  // 导出（飞书 lark-cli / Notion 官方 ntn CLI）：与导入连接、导出授权两套凭据域
  // 解耦，Gateway 不保存任何 CLI token。
  const documentImportService = new DocumentImportService(
    db,
    documentService,
    config.cliConnector ?? null,
    config.dataDir,
    {
      assetBridgeUrl: config.documentAssetBridgeUrl ?? null,
      // Notion 行内评论按块查询走官方 ntn（macOS；缺省自动跳过并告警）。
      notionCli: config.notionCli ?? null,
      // 飞书导入通道（列举/正文/评论/媒体）换轨 lark-cli。
      larkCli: config.larkCli ?? null,
      // 连接器页「关闭飞书」闸门：墓碑存在即视为关闭（lark-cli 凭据保留）。
      isFeishuDisabled: () => connectorTombstones.has("feishu", "default"),
    },
  );
  const agentDocumentExportService = new AgentDocumentExportService(
    db,
    documentService,
    config.larkCli ?? null,
    config.dataDir,
    {
      logger: { info: (obj, msg) => app.log.info(obj, msg), warn: (obj, msg) => app.log.warn(obj, msg) },
      assetBridgeUrl: config.documentAssetBridgeUrl ?? null,
      notionCli: config.notionCli ?? null,
      isFeishuDisabled: () => connectorTombstones.has("feishu", "default"),
    },
  );
  // 评论服务在 host 之前构建并共享单实例：registry 的 AI 审阅工具与 REST 路由共用。
  const documentCommentService = new DocumentCommentService(db, (documentId) => Boolean(documentService.get(documentId)));
  // PPT 逐页进度上报器（只报不定）：早于 documentMcpHost 构建共享单实例——
  // registry 的 set_page 落页即广播快照，slides_draft 布闸挂转发。
  const slidesProgress = new SlidesProgressTracker();
  // Office 桥与视觉复检器共享单实例：office-plugin 工具与 slides-layout-tail 落页尾部共用。
  const officeBridgeClient = config.officeBridge ? new OfficeBridgeClient(config.officeBridge) : null;
  const slidesVisualReviewer = new SlidesVisualReviewer({ vlm: () => createVlmProvider(config) });
  // 图片对象库 + 生图中转：PPT 配图与 Word 配图（word_agent_illustration）共用同一实例——
  // 生图产物按内容哈希进 CAS，读回字节再插进文档，模型不搬运 base64。
  const slideImageStore = new SlideImageStore(db, config.dataDir);
  const slidesStyleImageGenerator = new SlidesStyleImageGenerator(aiRelaySessions, slideImageStore);
  const documentIllustration: DocumentIllustrationPorts = {
    generate: async (prompt) => {
      const generated = await slidesStyleImageGenerator.generateImage({ prompt });
      return { contentHash: generated.contentHash };
    },
    read: (contentHash) => slideImageStore.readByHash(contentHash),
  };
  // 无模版风格管线依赖 filesService/materials（晚于工具装配创建）：getter 惰性取。
  const slidesStyleDepsRef: { current: SlidesStyleStageDeps | null } = { current: null };
  const documentMcpHost = new DocumentMcpHost(
    documentService,
    undefined,
    createBuiltinDocumentCapabilityRegistry(
      // agent 写 Word：桌面注入 NXCORE_OFFICE_BRIDGE_URL/TOKEN 后启用。
      officeBridgeClient,
      // PPT 逐页进度上报：set_page 成功落页即广播快照。
      slidesProgress,
      // PPT 落页视觉复检：配置 vlm 时启用（内部自带降级）。惰性解析——
      // 设置页保存 vlm 段后 runtime config 热替换，复检无需重启网关即生效。
      slidesVisualReviewer,
      // 改“用户正开着的那份”Word/Excel：filesService 在更后面创建，惰性取。
      () => filesService,
      // Word 配图：宿主生图（ai-relay）+ 图片对象库，一步生成并插入。
      documentIllustration,
    ),
    documentOperationService,
    (diagnostic) => {
      const { level, event, ...fields } = diagnostic;
      app.log[level](fields, event);
    },
  );
  const notificationMcpHost = new NotificationMcpHost(
    config.notificationBridge ? new NotificationBridgeClient(config.notificationBridge) : null,
  );
  const externalDocumentProjectionService = new ExternalDocumentProjectionService(
    db,
    documentService,
    documentOperationService,
    documentMcpHost.capabilities,
  );
  await documentMcpHost.capabilities.recover();
  const agentResolver = createAgentResolver(config);
  // 格式映射 agent：就绪即 attach（映射生成依赖它；未配置 AI 时保持 pending 语义）。
  const subagentConfig = config.subagents ?? {
    enabled: true,
    definitionsDir: bundledAgentDefinitionsDir(),
    runtimeDir: resolve(config.dataDir, "agent", "subagents"),
    defaultTimeoutMs: 300_000,
    maxConcurrent: DEFAULT_SLIDES_MAX_CONCURRENT + DEFAULT_DEFAULT_MAX_CONCURRENT + DEFAULT_BACKGROUND_MAX_CONCURRENT,
    slidesMaxConcurrent: DEFAULT_SLIDES_MAX_CONCURRENT,
    defaultMaxConcurrent: DEFAULT_DEFAULT_MAX_CONCURRENT,
    backgroundMaxConcurrent: DEFAULT_BACKGROUND_MAX_CONCURRENT,
    slidesDeckConcurrency: DEFAULT_SLIDES_DECK_CONCURRENCY,
  };
  const subagentRegistry = new SubagentRegistry(
    db,
    subagentConfig,
    config.pi?.mcp?.mcpServers ?? {},
    app.log,
  );
  await subagentRegistry.initialize();
  const subagentRuntimeManager = new SubagentRuntimeManager(config, subagentConfig, externalCalls);
  // 「技能」页：清单来自 bundle 与子 Agent 清单，启停状态落 agent_skill_states。
  // 注册表是晚绑定的（上面刚建好），用惰性取值避免把它的初始化顺序搬到这里。
  const skillService = new SkillService({
    store: new AgentSkillStateStore(db),
    definitionsDir: bundledAgentDefinitionsDir(),
    subagents: () => subagentRegistry.listAvailable(),
    // 用户技能写在数据目录（应用包内的 agents/ 是只读发布物），可新增/删除。
    userSkills: new UserSkillStore(join(config.dataDir, "agent", "skills")),
    logger: { warn: (fields, message) => app.log.warn(fields, message) },
  });
  // 子 Agent 的技能读取工具按闸门过滤（被停用的技能不给读）。
  subagentRuntimeManager.setSkillGate(skillService);
  // slides 两段式子代理工具面（create：slides-planner 出内容方案 → slides-builder
  // 落页；edit：slides-builder 直改）——方案代理拿只读面（无 PPT 工具、不落页；
  // 素材检索也不在工具面，arrange 前由网关按页预取随输入下发），
  // 落页代理只拿 PPT 四件套（方案已带内容，不再检索）；写入/调度类由工厂内 allowlist 拒绝。须在首次 dispatch 前注册。
  subagentRuntimeManager.registerAgentTools("slides-planner", () => createSlidesPlannerAgentTools({
    documentTools: createDocumentPiTools(documentMcpHost),
    webSearchTools: config.webSearch
      ? createWebSearchPiTools(agentResolver, externalCalls)
      : [],
  }));
  subagentRuntimeManager.registerAgentTools("slides-builder", () => createSlidesBuilderAgentTools({
    documentTools: createDocumentPiTools(documentMcpHost),
  }));
  // slides-layouter（每页布局树设计代理）工具面：只有 slides_layout_validate——
  // 归一→编译→量测的确定性环，契约经 deck-contract-context 按 token 取用。须在首次 dispatch 前注册。
  subagentRuntimeManager.registerAgentTools("slides-layouter", () => createSlidesLayouterAgentTools());
  // 布局代理的提交期树校验：validate 过的好树在 submit 一步被模型抄坏过（2026-10-17
  // 深圳 deck 第 6 页，根节点 direction 丢失静默兜底）——坏树在 submit 处拒收，让模型当场重交。
  // 审页代理已砍：布局代理写完页面用渲染图自审，不再有独立的 slides-reviewer。
  subagentRuntimeManager.registerAgentResultValidator("slides-layouter", createSlidesTreeResultValidator());
  for (const developerAgent of subagentRegistry.listAvailable()) {
    agentResolver.register({
      id: developerAgent.id,
      name: developerAgent.name,
      description: developerAgent.description,
      configDirectory: developerAgent.revision.agentDirectory,
      kind: "developer",
    }, () => subagentRuntimeManager.acquire(developerAgent.revision), { disposeRuntime: false });
  }
  const subagentOrchestrator = new SubagentOrchestrator(
    db,
    subagentConfig,
    subagentRegistry,
    subagentRuntimeManager,
    app.log,
  );
  // Room 创建整理走 internal_workflow 异步调度；logger 供失败降级日志。
  // 写作风格服务提前创建（仅需 db）：dispatcher 与 agentService 的注入
  // provider 在此接线，worker/路由仍在文档 worker 附近启动注册。
  // 版本变更概览（历史面板 AI 概览标题）复用 background 模型；失败由服务退回本地规则摘要。
  let versionSummaryRuntime = createVersionSummaryRuntime(config);
  // 文档速览（文章级 AI 摘要）：独立隔离 runtime；未配置时路由层置 aiAvailable=false。
  // let + 热替换：SaaS 登录后 runtime 配置才到达，boot 快照的 null 会让速览/
  // 章节预览在首次登录后一直 503（下方 onChange 重建）。
  let documentOverviewRuntime = createDocumentOverviewRuntime(config);
  let resolveFileMarkdown: ((fileId: string) => Promise<string | null>) | undefined;
  let resolveAgentConversation: ((threadId: string, query: string) => Promise<string | null>) | undefined;
  const recoveredSubagentInvocations = subagentOrchestrator.initialize();
  if (recoveredSubagentInvocations > 0) {
    app.log.info({ recoveredSubagentInvocations }, "subagent invocations interrupted after restart");
  }
  // 渠道会话（Claude Code / Codex 整段锁定）的 EverOffice 工具 MCP host：
  // token-in-path 鉴权，文档能力复用 documentMcpHost 的全量 document_* 读写。
  const gatewayLoopbackHost = ["0.0.0.0", "::"].includes(config.host) ? "127.0.0.1" : config.host;
  // 渠道 MCP 注入 URL 必须用 listen 后的实际绑定地址：桌面 main 以 --port 0 拉起网关，
  // 构造期的 config.port 是 0，注入 http://127.0.0.1:0 会让 CLI 连接失败并静默丢弃该 MCP 服务器。
  const channelMcpBaseUrl = (): string => {
    const bound = app.server?.address();
    if (bound && typeof bound === "object" && bound.port > 0) {
      return `http://${["0.0.0.0", "::"].includes(bound.address) ? "127.0.0.1" : bound.address}:${bound.port}`;
    }
    return `http://${gatewayLoopbackHost}:${config.port}`;
  };
  const channelMcpHost = new ChannelMcpHost(
    documentMcpHost.capabilities,
    channelMcpBaseUrl,
    (level, event, fields) => app.log[level](fields ?? {}, event),
  );
  // 提前实例化：主 Agent 的 local_agent_dispatch 工具（@ 点名本机 Agent）需要闭包它。
  // MCP 注入仅限渠道锁定会话（activeAgentId 非内置档位）；@ 点名派发的子任务
  // 走最小材料模型，不开放 EverOffice 工具。人工审批与 MCP 注入同一判据：
  // 渠道会话的 CLI 工具权限走 UI 审批，派发子任务维持 mutationAllowed 自动应答。
  const isChannelAgentSession = (sessionId: string): boolean => {
    const session = db.select({ activeAgentId: agentSessions.activeAgentId })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    return Boolean(session && channelAgentIdFromAgentId(session.activeAgentId));
  };
  const localAgentRuntimeRegistry = new LocalAgentRuntimeRegistry(
    async (input) => {
      if (!isChannelAgentSession(input.sessionId)) return [];
      return channelMcpHost.mcpServersForRun(input);
    },
    (input) => isChannelAgentSession(input.sessionId),
  );
  const localAgentDispatchStore = new LocalAgentDispatchStore(db);
  // dispatch 工具先于 AgentService 构建，run 级分发来源用晚绑定引用接线。
  const localAgentDispatchSourceRef: { current: ((runId: string) => LocalAgentDispatchSource | undefined) | null } = {
    current: null,
  };
  // 项目空间目录（单写者）：创建空间时落 `<dataDir>/Workspace/<slug>`，默认空间补 `Workspace/inbox`。
  const workspaceLayoutService = new WorkspaceLayoutService({
    dataDir: config.dataDir,
    appVersion: process.env.EVERROOM_APP_VERSION?.trim() || "0.0.0",
    logger: gatewayLogger.logger,
  });
  const spaceLibraryWriter = new SpaceLibraryWriter(db, config.dataDir, workspaceLayoutService);
  // 空间缓存（P3）：tmp/derived/objects 的统计与回收；启动 60s 后清一遍 tmp（不阻塞启动）。
  const spaceCacheManager = new SpaceCacheManager(db, workspaceLayoutService);
  // 空间记忆库（P2）：绑了目录的工作区，记忆落 `<space>/.everoffice/memory`；否则仍是全局库。
  const spaceMemoryRoots = new SpaceMemoryRoots(db, workspaceLayoutService);
  // Agent 工作目录（P2）：绑了目录的空间，pi 会话 cwd / 沙箱根 / AGENTS.md 都指向空间根。
  const spaceAgentRoots = new SpaceAgentRoots(db, workspaceLayoutService);
  // 计划（任务 / todo）：数据面 + 认领。工具要早于 AgentService 构建，
  // 「指派即开会话」用晚绑定引用接线（同 localAgentDispatchSourceRef 的做法）。
  const planStream = new PlanStreamHub();
  const planDispatchRef: { current: ((input: PlanDispatchInput) => Promise<PlanDispatchResult>) | null } = {
    current: null,
  };
  const planService = new PlanService({
    db,
    logger: (level, event, fields) => app.log[level](fields ?? {}, event),
    spaceOf: (workspaceId) => {
      const row = db
        .select({ name: agentWorkspaces.name, path: agentWorkspaces.path })
        .from(agentWorkspaces)
        .where(eq(agentWorkspaces.id, workspaceId))
        .get();
      if (!row) return null;
      if (!row.path) return { name: row.name, root: null, libraryPath: null, artifactsPath: null };
      const read = workspaceLayoutService.detect(row.path);
      const paths = workspaceLayoutService.pathsOf(
        row.path,
        read.status === "ok" ? read.marker.layout : undefined,
      );
      return {
        name: row.name,
        root: paths.root,
        libraryPath: paths.library,
        // v2：资料库根＝空间根，产物平铺在根上，不再单设 outputs/。
        artifactsPath: paths.library,
      };
    },
    dispatch: (input) => {
      if (!planDispatchRef.current) {
        throw new PlanError("plan_dispatch_unavailable", "plan_dispatch_unavailable");
      }
      return planDispatchRef.current(input);
    },
    onChange: (workspaceId, item, event) => planStream.publish({ workspaceId, item, event }),
    // 任务完成写一条记忆：今日洞察/回忆里能引用"今天推进了什么"（P3 联动）。
    onCompleted: (item) => {
      memoryService.remember({
        content: `完成任务「${item.title}」${item.resultSummary ? `：${item.resultSummary}` : ""}`,
        tags: ["plan", "task", "completed"],
        workspaceId: item.workspaceId,
        category: "fact",
        confidence: "inferred",
      });
    },
  });
  // 概览「动态」：runs + 文件库 + 计划事件流的派生读模型（不建 feed 表）。
  const workspaceActivityService = new WorkspaceActivityService({ db });
  const planLeaseReaper = new PlanLeaseReaper({
    service: planService,
    // 自动认领默认关：没人叫它也能自己开工是产品决策，不是技术决策。
    autoClaim: process.env.NXCORE_PLAN_AUTO_CLAIM === "1",
    droppedRetentionDays: Number(process.env.NXCORE_PLAN_RETENTION_DAYS ?? "30") || 0,
    logger: (level, event, fields) => app.log[level](fields ?? {}, event),
  });
  if (process.env.NODE_ENV !== "test") {
    const timer = setTimeout(() => {
      for (const spaceId of spaceCacheManager.boundSpaceIds()) {
        void spaceCacheManager.gc(spaceId).catch(() => undefined);
      }
    }, 60_000);
    timer.unref?.();
  }

  // 长期记忆（hippo-memory）：默认开启，无环境变量开关；库在 <dataDir>/memory/hippo。
  // 进程内嵌库（node:sqlite），无独立服务与端口，见 docs/hippo-memory-adoption-plan.zh-CN.md。
  const memoryService = new MemoryService({
    root: config.memory?.root ?? join(config.dataDir, "memory", "hippo"),
    // 空间绑定目录后，该空间的记忆落 `<space>/.everoffice/memory`（P2，方案 §8.5）。
    spaceRootFor: spaceMemoryRoots.resolve,
    enabled: true,
    logger: (level, event, fields) => app.log[level](fields ?? {}, event),
  });
  const primaryIntegrations: AgentRuntimeIntegrationOptions = {
    externalCalls,
    skills: skillService,
    ...(connectorMcp ? { connectorMcp: { url: connectorMcp.url } } : {}),
    memory: memoryService,
    // 项目空间根（P2，方案 §8.5）：会话所属空间绑了目录，这一轮 run 的 cwd 就是空间根。
    projectRoot: (input) => spaceAgentRoots.resolve(input.workspaceId),
    tools: [
      ...createDocumentExportPiTools(agentDocumentExportService),
      ...createDocumentImportPiTools(documentImportService),
      // 当前浏览的 Office 文件（file_entries）正文读取：filesService 与本服务
      // 都晚于本对象创建，用惰性取值；activeFile 由运行期 input 提供。
      createFileReadPiTool({
        files: () => filesService,
        understanding: () => documentUnderstandingService,
      }),
      // 按文件名在文件库定位 fileId：用户只说“那份报告”/要改的文件没打开时，
      // 先搜出 fileId 再交给 file_read / word_agent_*（同样惰性取 filesService）。
      createFileSearchPiTool({ files: () => filesService }),
      // 分页浏览资料库/产物：用户问题指向自有材料但说不出文件名时，模型自己翻库
      // （库可能上千份，不能靠运行提示塞一份「最近 N 条」的抽样快照）。
      createLibraryBrowsePiTool({ files: () => filesService }),
      ...(subagentConfig.enabled
        ? createSubagentPiTools(subagentRegistry, subagentOrchestrator, {
            resolveFileMarkdown: async (fileId) => resolveFileMarkdown?.(fileId) ?? null,
            // slides_draft 的草稿读写数据源：读权威文档快照（sourceDocumentIds 预取
            // 与 generate 阶段读回用户确认的草稿）。
            resolveDocumentForDraft: (documentId) => documentService.readDocumentForAgent(documentId),
            // PPT 逐页进度：create 编排方案产出后登记，落页即广播快照。
            slidesProgress,
            slidesCheckpoints: new SlidesGenerationCheckpointStore(db),
            // PPT 无模版风格管线（纵览图→提取→风格卡→自校）。
            slidesStyle: subagentConfig.enabled ? () => slidesStyleDepsRef.current : null,
            // slides 语义内容链路（storyboard/v3）：内容契约装配——storyboard 落库 + 实验隔离 hash。
            slidesEditor: subagentConfig.enabled
              ? {
                  store: new SlidesStoryboardStore(db), active: true,
                  generationConfig: () => ({
                    // 内容链路实际用到的模型：planner/editor 走 background，layouter 走主模型。
                    models: [config.backgroundPi, config.pi].map(model => model ? {
                      provider: model.provider, model: model.model, baseUrl: model.baseUrl,
                      api: model.api, reasoning: model.reasoning, maxTokens: model.maxTokens,
                      contextWindow: model.contextWindow, temperature: model.temperature,
                    } : null),
                    slidesReasoning: subagentConfig.slidesReasoning,
                  }),
                }
              : null,
            // 布局树落页装配（generate 尾部）：与 office-plugin 共享同一批实例；
            // readMaterialBlob 供图片 AR 解析（everroom-material:// 按 hash 回源）。
            slidesLayoutOffice: subagentConfig.enabled
              ? {
                  bridge: officeBridgeClient,
                  deckConcurrency: subagentConfig.slidesDeckConcurrency ?? DEFAULT_SLIDES_DECK_CONCURRENCY,
                  readMaterialBlob: async (hash) => {
                    const content = await slideImageStore.readByHash(hash).catch(() => null);
                    return content ? new Uint8Array(content.buffer) : null;
                  },
                  fetchImageHead: async (url) => {
                    try {
                      const response = await fetch(url, {
                        headers: { Range: "bytes=0-65535" },
                        signal: AbortSignal.timeout(3000),
                        redirect: "follow",
                      });
                      if (!response.ok && response.status !== 206) return null;
                      return new Uint8Array(await response.arrayBuffer());
                    } catch {
                      return null;
                    }
                  },
                }
              : null,
            // PPT 草稿文档：planner 内容方案 → 落成 Room 可编辑文档（用户确认后再生成）。
            createSlidesDraftDocument: async ({ roomId, title, markdown }) => {
              const documentId = randomUUID();
              const prepared = documentService.prepareAgentDocumentDraft({ documentId, roomId, title, markdown });
              await documentService.import({
                id: prepared.documentId,
                roomId: prepared.roomId,
                title: prepared.title,
                contentJson: prepared.content,
                origin: "native",
              });
              return { documentId: prepared.documentId, title: prepared.title };
            },
            // 草稿回收：落页成功后网关侧进回收站（可恢复），桌面清单随之移除。
            trashSlidesDraftDocument: async (documentId) => {
              await documentService.delete(documentId);
            },
         })
        : []),
      // 计划（任务 / todo）：agent 可以建任务、读认领包、认领、推进、放回。
      ...createPlanPiTools(planService),
      ...createNotificationPiTools(notificationMcpHost),
      ...createLocalAgentDispatchTools({
        registry: localAgentRuntimeRegistry,
        store: localAgentDispatchStore,
        resolveDispatchSource: (runId) => localAgentDispatchSourceRef.current?.(runId),
      }),
      ...createReferencedAgentConversationTools(async (threadId, query) => (
        resolveAgentConversation?.(threadId, query) ?? null
      )),
    ],
  };
  registerPrimaryAgent(agentResolver, config, documentMcpHost, primaryIntegrations);
  // 会话档位衍生 runtime（main-direct / main-lite）：与 main 共用 integrations。
  registerModelTierAgents(agentResolver, config, documentMcpHost, primaryIntegrations);
  const agentRuntime = agentResolver.resolve(BUILTIN_AGENT_IDS.primary);
  app.log.info(
    {
      runtimeId: agentRuntime.id,
      ...(config.pi
        ? {
            provider: config.pi.provider,
            model: config.pi.model,
            baseUrl: config.pi.baseUrl,
            api: config.pi.api,
          }
        : {}),
      ...(isPiRuntimeConfigured(config.litePi)
        ? { liteModel: config.litePi!.model }
        : {}),
    },
    "agent runtime configured",
  );
  const agentService = new AgentService(
    db,
    agentRuntime,
    new AgentEventBroker(),
    app.log,
    documentService,
    documentMcpHost,
    false,
    (target) => localAgentRuntimeRegistry.resolve(target),
  );
  agentService.setConnectorContextResolver(createConnectorContextResolver(connectorRuntime));
  // 档位 runtime 解析：现取 resolver 缓存（热重载后自然换新）；配置缺席时
  // 返回 null，service 回落 primary——main-direct 未配置（AI 全空）时与
  // main 同为占位，回落行为一致。
  agentService.setTierRuntimeResolver((agentId) => {
    if (!agentResolver.has(agentId)) return null;
    if (agentId === BUILTIN_AGENT_IDS.lite && !isPiRuntimeConfigured(config.litePi)) return null;
    if (agentId === BUILTIN_AGENT_IDS.primaryDirect && !isPiRuntimeConfigured(config.pi)) return null;
    return agentResolver.resolve(agentId);
  });
  agentService.setChannelSessionRevoker((sessionId) => channelMcpHost.revokeAgentSession(sessionId));
  localAgentDispatchSourceRef.current = (runId) => agentService.getLocalAgentDispatchSource(runId);
  await agentService.initialize();
  // 计划的「交给 Agent」= 建会话 + 用认领包起一轮 run（用户能在会话里看到全过程）。
  planDispatchRef.current = async ({ item, prompt }) => {
    const label = item.title.slice(0, 60) || "计划任务";
    const session = agentService.createSession({ pageLabel: label, workspaceId: item.workspaceId });
    const run = await agentService.startRun(session.id, {
      prompt,
      displayPrompt: `执行计划任务：${item.title}`,
      idempotencyKey: `plan-assign:${item.id}:${randomUUID()}`,
      context: { pageLabel: label },
    });
    return { sessionId: session.id, runId: run.id };
  };
  const sessionTitleService = new SessionTitleService(createSessionTitleRuntime(config));
  // 工作会话标题：渲染层（对话面板开着时）先写；这里延迟兜底，覆盖后台跑完 /
  // 计划指派等「没人在看」的会话，二者都只在标题仍是自动占位时替换，不会互相覆盖。
  const autoSessionTitles = new AutoSessionTitles({
    db,
    generate: (input) => sessionTitleService.generate(input),
    logger: (level, event, fields) => app.log[level](fields ?? {}, event),
  });
  agentService.setSessionTitleGenerator((sessionId, runId) => autoSessionTitles.schedule(sessionId, runId));
  const conversationSuggestionService = new ConversationSuggestionService(createConversationSuggestionRuntime(config));
  runtimeConfigManager.onChange((snapshot) => {
    app.log.info({
      event: "runtime_config.selected",
      source: snapshot.selectedSource,
      availableSources: snapshot.availableSources,
      configVersion: snapshot.configVersion,
      primaryConfigured: isRuntimePrimaryConfigured(snapshot.config),
      runtimeSections: Object.keys(snapshot.config).filter((key) =>
        ["primary", "background", "cursorCompletion", "vlm", "webSearch"].includes(key)),
    }, "runtime config selected");
    applyRuntimeConfig(config, snapshot.config);
    // webSearch：boot 时 env 未配、runtime config 保存后才注册的场景。
    if (registerWebSearchAgentIfMissing(agentResolver, config)) {
      app.log.info("web search agent registered from runtime config");
    }
    // main-lite：boot 时 litePi 未配置、runtime config 保存 lite 段后注册。
    if (registerLiteAgentIfMissing(agentResolver, config, documentMcpHost, primaryIntegrations)) {
      app.log.info("lite tier agent registered from runtime config");
    }
    void hotReloadAgentRuntimes();
  });

  /**
   * agent runtime 全量热重载：runtime config 保存与 connector 会话变更
   * （PUT/DELETE /v1/connector-session）共用。connector 会话变更只影响
   * primary 的 oo pi-tools（工具列表在 createAgentRuntime 闭包里求值）。
   */
  async function hotReloadAgentRuntimes(): Promise<void> {
    try {
      const primary = agentResolver.reload(BUILTIN_AGENT_IDS.primary);
      // await 进本函数的 catch：replaceRuntime 的 dispose 链可能 reject，
      // void 调用漏接即未处理拒绝、直接杀死网关进程（2026-10-17 排障）。
      await agentService.replaceRuntime(primary.current);
      // 档位 runtime 热替换：main-direct 恒重载（占位/真身都由工厂决定）；
      // main-lite 仅在仍配置时重载（工厂返回 null 会炸 trackedRuntime），
      // 配置被移除时注册残留但 tier resolver 拦截，会话回落 primary。
      const direct = agentResolver.reload(BUILTIN_AGENT_IDS.primaryDirect);
      await direct.previous?.dispose();
      if (isPiRuntimeConfigured(config.litePi) && agentResolver.has(BUILTIN_AGENT_IDS.lite)) {
        const lite = agentResolver.reload(BUILTIN_AGENT_IDS.lite);
        await lite.previous?.dispose();
      }
      for (const agentId of [BUILTIN_AGENT_IDS.cursorCompletion, BUILTIN_AGENT_IDS.webSearch]) {
        if (!agentResolver.has(agentId)) continue;
        const { previous } = agentResolver.reload(agentId);
        await previous?.dispose();
      }
      // 子 Agent 缓存作废（下次 acquire 以新 backgroundPi 重建）。
      await subagentRuntimeManager.invalidate();
    } catch (error) {
      app.log.error({ error: error instanceof Error ? error.message : String(error) }, "runtime config reload failed");
    }
  }
  // 文件管理中心（U9 唯一字节入口）：对象库 + uploaded/parsed 登记。
  const filesService = new FilesService(db, config.dataDir);
  // 论文排版管线：模版解析与装订映射走子代理，渲染走桌面 office-bridge。
  const thesisFormatService = new ThesisFormatService({
    db,
    files: filesService,
    orchestrator: subagentOrchestrator,
    officeBridge: config.officeBridge ? new OfficeBridgeClient(config.officeBridge) : null,
    // LibreOffice 等中间产物落空间 scratch（`.tmp/thesis/…`），随空间清理。
    spaceScratch: spaceCacheManager,
    // 排版作业的阶段耗时/失败原因必须落网关日志：否则只能靠外部记录反推。
    logger: { info: (obj, msg) => app.log.info(obj, msg), warn: (obj, msg) => app.log.warn(obj, msg) },
  });
  // 幻灯片图片对象库（原素材库的字节存取部分）：与 Word 配图共用上面的 slideImageStore，
  // 生图产物与文档内嵌图按内容哈希寻址，服务 everroom-material:// 引用与 GET /v1/materials/:hash 回源。
  filesService.initializeCatalog();
  // PPT 无模版风格管线装配：生图走 ai-relay 会话、读图走素材按哈希回源、
  // 演示页渲染走桌面 office-bridge 的只渲染端点、VLM 走 runtime vlm 槽位。
  const slidesStyleOfficeClient = config.officeBridge ? new OfficeBridgeClient(config.officeBridge) : null;
  // 配图会话存储与后台逐张生成循环（过目卡轮询路由共用存储实例）。
  const pageImageSessionsStore = new SlidesPageImageSessionStore(db);
  const pageImageRunner = new SlidesPageImageRunner();
  slidesStyleDepsRef.current = {
    sessions: new SlidesStyleSessionStore(db),
    images: slidesStyleImageGenerator,
    vlm: createVlmProvider(config),
    readMaterialBytes: (hash) => slideImageStore.readByHash(hash),
    demoRenderer: slidesStyleOfficeClient
      ? {
        renderPptx: async (title, pages) => slidesStyleOfficeClient.renderPptx({
          title,
          pages: pages.map((page) => JSON.stringify(page)),
        }),
      }
      : {
        renderPptx: async () => {
          throw new Error("office_bridge_unavailable");
        },
      },
    saveDemoPng: async (png) => slideImageStore.saveImageBlob(png, "image/png"),
    pageImageSessions: pageImageSessionsStore,
    pageImageRunner: pageImageRunner,
    // settle 的 outlineRoles 来源：按风格会话绑定的草稿读回页结构（读取失败时省略该输入）。
    resolveDraftDocument: (documentId) => {
      try {
        return documentService.readDocumentForAgent(documentId);
      } catch {
        return null;
      }
    },
  };
  const dataMigrationService = new DataMigrationService(db, sqlite);
  const searchService = new SearchService(db, sqlite);
  await app.register(searchRoutes(searchService));
  await app.register(memoryRoutes(memoryService));
  dataMigrationService.setFilesService(filesService);
  dataMigrationService.recover();
  // @ 引用解析：先查导入的外部线程；未命中（本应用自有会话 id）回退读 agent_sessions 历史。
  resolveAgentConversation = async (threadId, query) => {
    try {
      return await dataMigrationService.buildReferenceContext(threadId, query);
    } catch {
      return agentService.buildSessionReferenceContext(threadId);
    }
  };
  agentService.setExternalConversationResolver(dataMigrationService);
  agentService.setFilesService(filesService);
  agentService.setWorkspaceLayout(workspaceLayoutService);
  // 资料库落盘（P1）：入库/改名/删除时同步空间 Library；未绑目录的空间保持旧行为。
  filesService.setSpaceLibrary(spaceLibraryWriter);
  const documentUnderstandingService = new DocumentUnderstandingService(
    db,
    filesService,
    createVlmProvider(config),
    config.dataDir,
  );
  resolveFileMarkdown = async (fileId) => {
    const deadline = Date.now() + 120_000;
    while (Date.now() <= deadline) {
      const markdown = filesService.markdownOf(fileId)
        ?? filesService.catalogMarkdownOf(fileId)
        ?? documentUnderstandingService.markdownForFile(fileId);
      if (markdown !== null) return markdown;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return null;
  };
  runtimeConfigManager.onChange(() => {
    const visualProvider = createVlmProvider(config);
    documentUnderstandingService.replaceVisualProvider(visualProvider);
  });
  subagentRuntimeManager.registerAgentTools(
    "multimodal-document-parser",
    () => createDocumentUnderstandingTools(documentUnderstandingService),
  );
  subagentRuntimeManager.registerAgentResultValidator(
    "multimodal-document-parser",
    createDocumentAnalysisResultValidator(documentUnderstandingService),
  );
  const agentSchedulerService = new AgentSchedulerService(db, agentService);
  agentSchedulerService.initialize();
  const purgedUnsupportedFiles = await filesService.purgeUnsupportedFiles();
  if (purgedUnsupportedFiles > 0) {
    app.log.info({ purgedUnsupportedFiles }, "purged unsupported JSON file records");
  }
  let documentListSyncWorker: DocumentListSyncWorker | null = null;
  let documentHistoryBackfillWorker: DocumentHistoryBackfillWorker | null = null;
  let documentIndexBackfillWorker: DocumentIndexBackfillWorker | null = null;
  app.addHook("onClose", async () => {
    autoSessionTitles.dispose();
    // Stop producers while all ingest/classification dependencies are still alive.
    await filesService.dispose();
    clearInterval(documentOperationExpiryTimer);
    await agentService.dispose();
    await localAgentRuntimeRegistry.dispose();
    await channelMcpHost.close();
    await connectorMcpServer.close().catch(() => undefined);
    await subagentOrchestrator.dispose();
    slidesProgress.dispose();
    await documentMcpHost.close();
    await documentListSyncWorker?.dispose();
    await documentHistoryBackfillWorker?.dispose();
    await documentIndexBackfillWorker?.dispose();
    planLeaseReaper.stop();
    await agentSchedulerService.dispose();
    await agentResolver.dispose();
    await notificationMcpHost.close();
    // 退出前先把未提炼的会话段冲刷掉（带超时，尽力而为），再停定时器。
    await memoryDistiller.flushAll().catch(() => undefined);
    journalScheduler.stop();
    memoryProfile.stop();
    memoryDistiller.dispose();
    memoryService.stop();
    sqlite.close();
    await gatewayLogger.close();
  });
  // 同一份状态快照同时服务 /v1/agent/status 与 /v1/agent-debug/*（运行态口径一致）。
  const agentStatusService = new AgentStatusService(agentResolver, subagentOrchestrator);
  await app.register(agentRoutes(agentService, agentStatusService, localAgentDispatchStore));
  // 项目空间目录：默认落点预览 / 判定 / 发现 / 健康 / 修复（见 docs/project-space-layout-plan.zh-CN.md §6.2）。
  await app.register(workspaceLayoutRoutes(workspaceLayoutService, agentService, {
    db,
    writer: spaceLibraryWriter,
    files: filesService,
    cache: spaceCacheManager,
  }));
  // 「技能」页：清单/正文/启停。开关变化后重装运行时（skillPrompts 在新建 runtime 时定型）。
  await app.register(skillRoutes(skillService, {
    // 开关与目录变化都要重装运行时：skillPrompts 在新建 runtime 时定型。
    onStateChanged: async () => { await hotReloadAgentRuntimes(); },
    onCatalogChanged: async () => { await hotReloadAgentRuntimes(); },
  }));
  await app.register(subagentRoutes(subagentOrchestrator));
  // Agent 调试面板（只读）：数据来自 runtime.describe() 的实际装配 + 使用记录。
  await app.register(agentDebugRoutes(new AgentDebugService({
    config,
    resolver: agentResolver,
    statuses: agentStatusService,
    subagents: subagentRegistry,
    invocations: subagentOrchestrator,
    usage: new AgentDebugUsageStore(db),
  })));
  const reloadMcpRuntimes = async (): Promise<void> => {
    const primary = agentResolver.reload(BUILTIN_AGENT_IDS.primary);
    await agentService.replaceRuntime(primary.current);
    await primary.previous?.dispose();
  };
  await app.register(mcpRoutes(mcpConfigManager, reloadMcpRuntimes));
  app.post("/v1/security/secrets/logout", { schema: { tags: ["security"] } }, async () => {
    runtimeConfigManager.clearManagedSecrets();
    if (agentResolver.has(BUILTIN_AGENT_IDS.webSearch)) {
      const search = agentResolver.reload(BUILTIN_AGENT_IDS.webSearch);
      await search.previous?.dispose();
    }
    return { cleared: true };
  });
  await app.register(externalCallRoutes(externalCalls));
  await app.register(documentMcpRoutes(documentMcpHost));
  await app.register(channelMcpRoutes(channelMcpHost));
  // 外部 Agent 访问（PRD 0.2.0 第 7 章 L2.5）：持久连接 token + 范围过滤的对外
  // MCP 端点。REST（/v1/agent-access/*，连接页）走全局 bearer；MCP 端点
  // /v1/mcp/agents 以连接 token 自鉴权（auth 插件已豁免全局 bearer）。
  // 产物入库走 files 管线（sourceKind=agent-generated，CAS sha256 去重），
  // 与渠道 MCP 互不影响：渠道面向 EverOffice 自己拉起的 CLI，这里面向用户
  // 自行安装的外部工具。
  const agentAccessImportArtifact = async (input: {
    filename: string;
    buffer: Buffer;
    roomId: string | null;
    sourceKey: string;
  }) => {
    const result = await filesService.importFileStream({
      sourceKind: "agent-generated",
      sourceKey: input.sourceKey,
      originalName: input.filename,
      stream: Readable.from(input.buffer),
      ...(input.roomId ? { roomId: input.roomId, pipelines: { room: true, wiki: false } } : {}),
    });
    return {
      fileEntryId: result.fileEntryId,
      contentHash: result.contentHash,
      filename: input.filename,
    };
  };
  const agentAccessService = new AgentAccessService(db, {
    importArtifact: agentAccessImportArtifact,
    log: (level, event, fields) => app.log[level](fields ?? {}, event),
  });
  const agentAccessMcpHost = new AgentAccessMcpHost(
    agentAccessService,
    (connection) => createAgentAccessTools(
      {
        db,
        search: searchService,
        documents: documentService,
        files: filesService,
        agent: agentService,
      },
      connection,
      agentAccessService,
      agentAccessImportArtifact,
    ),
    (level, event, fields) => app.log[level](fields ?? {}, event),
  );
  await app.register(agentAccessRoutes(agentAccessService, agentAccessMcpHost, channelMcpBaseUrl));
  await app.register(agentAccessMcpRoutes(agentAccessMcpHost));
  await app.register(notificationMcpRoutes(notificationMcpHost));
  // 版本概览 worker：保存（document.changed）后异步判定重要性。重要变更
  // （标题变更/小节增删/变更块 ≥3/首版）直接生成 AI 概览；不重要变更先把
  // 本地规则摘要落库占位，等历史面板打开时懒加载升级为 AI 概览。
  const summaryPending = new Set<string>();
  documentEventBroker.listen((event) => {
    if (event.type !== "document.changed") return
    const document = (event.payload as { document?: { id?: unknown; version?: unknown } }).document
    const documentId = typeof document?.id === "string" ? document.id : null
    const version = typeof document?.version === "number" ? document.version : null
    if (!documentId || version === null || version < 1) return
    const key = `${documentId}:${String(version)}`
    if (summaryPending.has(key)) return
    summaryPending.add(key)
    // 稍等片刻让保存事务与事件可见，再后台生成；失败静默（懒加载兜底）。
    const timer = setTimeout(() => {
      summaryPending.delete(key)
      void documentService.maybeGenerateSummaryOnCommit(documentId, version, versionSummaryRuntime)
        .catch(() => undefined)
    }, 1_500)
    timer.unref?.()
  })
  // 文档读取触发：UI 打开文档即投递回溯任务，热文档不等游标扫描/24h 重扫。
  const indexBackfillReadTrigger = config.documentIndexBackfill?.enabled !== false
    ? new DocumentIndexBackfillReadTrigger(
      db,
      app.log,
      config.documentIndexBackfill?.readTriggerCooldownMs ?? 1_800_000,
    )
    : null;
  await app.register(documentRoutes(
    documentService,
    () => versionSummaryRuntime,
    indexBackfillReadTrigger,
  ));
  await app.register(documentCommentRoutes(documentCommentService));
  await app.register(documentOverviewRoutes(documentService, () => documentOverviewRuntime));
  await app.register(documentSectionPreviewRoutes(documentService, () => documentOverviewRuntime));
  await app.register(documentOperationRoutes(
    documentOperationService,
    documentMcpHost.capabilities,
    (context) => agentService.validateDocumentOperationContext(context),
  ));
  await app.register(externalDocumentProjectionRoutes(
    externalDocumentProjectionService,
    (context) => agentService.validateDocumentOperationContext(context),
  ));
  await app.register(documentImportRoutes(documentImportService));
  await app.register(agentDocumentExportRoutes(agentDocumentExportService));
  await app.register(slideImageRoutes(slideImageStore));
  await app.register(slidesPageImagesRoutes(pageImageSessionsStore));
  await app.register(thesisFormatRoutes(thesisFormatService));
  await app.register(dataMigrationRoutes(dataMigrationService));
  await app.register(filesRoutes(filesService));
  await app.register(documentUnderstandingRoutes(documentUnderstandingService));
  // 连接器页批量导入（fire-and-forget + DB 状态行，蓝本 runFrom）；启动时把
  // 进程死亡遗留的 running 批置 failed。Phase 2i-3：归房分类器与知识孵化已随
  // Room/knowledge 域删除，批量导入只剩「导入工作区文档库」一种行为，不再需要
  // 端口注入。
  const documentBatchImportService = new DocumentBatchImportService(
    db,
    documentImportService,
    app.log,
  );
  documentBatchImportService.recoverInterrupted();
  await app.register(documentImportBatchRoutes(documentBatchImportService, documentImportService));
  // SaaS 登录后 runtime 配置才到达：boot 快照的文档速览/章节预览/会话标题
  // runtime 是 null，配置热替换时同步重建（此前首次登录后这些能力一直 503 或
  // 静默降级，直到重启）。
  runtimeConfigManager.onChange(() => {
    documentOverviewRuntime = createDocumentOverviewRuntime(config);
    sessionTitleService.replaceRuntime(createSessionTitleRuntime(config));
    conversationSuggestionService.replaceRuntime(createConversationSuggestionRuntime(config));
    versionSummaryRuntime = createVersionSummaryRuntime(config);
    const backfillRuntime = config.documentIndexBackfill?.llmEnabled === false
      ? null
      : createIndexBackfillRuntime(config);
    documentIndexBackfillWorker?.replaceLlm(backfillRuntime ? new IndexBackfillLlm(backfillRuntime) : null);
  });
  // 版本导入只做解析产物登记（Phase 2 起不再扇出统一理解引擎三链路）。
  filesService.setVersionIngestor(async (input) => {
    const parsed = await documentUnderstandingService.parseVersion(input.fileEntryId, input.fileVersionId);
    return { parsedId: parsed?.id ?? null, dataType: "document" };
  });
  // 文档列举后台增量同步（15 分钟 delta + 每日全量对账）：只处理已有缓存行的
  // 连接，连接断开等预期失败在 worker 内静默跳过。
  documentListSyncWorker = new DocumentListSyncWorker(db, documentImportService, app.log);
  documentListSyncWorker.start();
  documentHistoryBackfillWorker = new DocumentHistoryBackfillWorker(
    db,
    documentService,
    app.log,
  );
  documentHistoryBackfillWorker.start();
  // 统一搜索索引 worker（2s 轮询 + 启动回填）。
  searchService.start();
  memoryService.start();
  // 记忆提炼/画像聚合的模型调用：内部一次性 runtime，档位按 lite → background → primary
  // 取第一个已配置的槽位。SaaS 激活时这些槽位已被重写到 /ai-relay 出口，
  // 因此这里只会走到 SaaS 下发的模型。
  //
  // 关键：**不能启动时定型**。桌面端要先过运行时配置 gate，SaaS 激活后才把
  // baseUrl/apiKey patch 进同一个 config 对象（applyRuntimeConfig 原地修改），
  // 启动那一刻档位往往是空的——一次定型就永远是 null，提炼与画像聚合从此永久失效
  // （日志表现为 memory.profile.failed: "no model slot configured for memory"，
  // 表现就是「页面永远没有用户画像」）。这里保留 null 并在每次调用时重新解析。
  const resolveMemoryRuntime = createMemoryRuntimeResolver(config);
  if (!resolveMemoryRuntime()) {
    app.log.warn("memory.model.unavailable: 未配置任何模型档位，记忆提炼与画像聚合将在档位就绪后启用");
  }
  const generateMemoryText = (prompt: string): Promise<string> => {
    const runtime = resolveMemoryRuntime();
    // 抛专用错误类型：档位未就绪属「环境没准备好」，提炼侧不计入重试次数。
    if (!runtime) throw new MemoryModelUnavailableError();
    return invokeRuntime(runtime, prompt, {
      sessionId: `memory:${randomUUID()}`,
      pageLabel: "记忆提炼",
      timeoutMs: 60_000,
    });
  };

  // 用户画像聚合：每日定时 + 新增偏好类事实达阈值时额外触发（双保险）。
  const memoryProfile = new MemoryProfileAggregator({
    service: memoryService,
    generate: generateMemoryText,
    logger: (level, event, fields) => app.log[level](fields ?? {}, event),
  });
  // 用户画像注入 system prompt：每轮 run 现取（带 60s TTL 缓存），记忆写入即失效。
  // 画像本身是「每日定时 + 8 条阈值」才更新，缓存对新鲜度没有影响，只为省掉
  // 每轮扫一遍记忆库 .md 的开销。
  const userProfilePrompt = createUserProfilePromptCache(memoryService);
  agentService.setUserProfileProvider(() => userProfilePrompt.get());

  // 每日洞察（主页「今日洞察」卡）：当天新写的记忆条目 → 一段可读的日记。
  // 供料只接记忆（见 docs/daily-journal-plan.zh-CN.md §3 的取舍）；
  // 时区取本机时区（网关由桌面端 spawn，同机），显式覆盖走 NXCORE_JOURNAL_TIMEZONE。
  const journalTimezone = process.env.NXCORE_JOURNAL_TIMEZONE?.trim()
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || "UTC";
  const journalService = new JournalService({
    db,
    list: () => memoryService.list({ limit: JOURNAL_MEMORY_LIST_LIMIT }),
    compose: (input) => composeJournal(input, {
      generate: generateMemoryText,
      isModelUnavailable: isMemoryModelUnavailable,
      logger: (level, event, fields) => app.log[level](fields ?? {}, event),
    }),
    timezone: () => journalTimezone,
    logger: (level, event, fields) => app.log[level](fields ?? {}, event),
  });
  const journalScheduler = new JournalScheduler({
    service: journalService,
    logger: (level, event, fields) => app.log[level](fields ?? {}, event),
  });
  await app.register(journalRoutes(journalService, journalScheduler));

  memoryService.setOnRemembered(() => {
    userProfilePrompt.invalidate();
    memoryProfile.noteNewMemory();
    // 记忆写入是「今日洞察」最主要的信号源：去抖后补一版（见 scheduler 的四道闸）。
    journalScheduler.noteSignal("memory");
  });
  memoryProfile.start();
  journalScheduler.start();

  // 工作空间洞察（概览 B 区卡片）：空间状态证据 → LLM 总结 + 建议（模板兜底）。
  // 与 journal 同一条模型通道（generateMemoryText）；不落库，内存缓存按证据指纹复用。
  const workspaceInsightService = new WorkspaceInsightService({
    agent: agentService,
    libraryCountSource: filesService,
    workspaceName: (workspaceId) =>
      db.select({ name: agentWorkspaces.name }).from(agentWorkspaces)
        .where(eq(agentWorkspaces.id, workspaceId)).get()?.name ?? "项目空间",
    compose: (evidence) => composeWorkspaceInsightViaLlm(evidence, {
      generate: generateMemoryText,
      isModelUnavailable: isMemoryModelUnavailable,
      modelName: "memory-slot",
      logger: (level, event, fields) => app.log[level](fields ?? {}, event),
    }),
    logger: (level, event, fields) => app.log[level](fields ?? {}, event),
  });
  await app.register(workspaceInsightRoutes(workspaceInsightService));

  // 会话结束的记忆蒸馏：run 正常完成后由 AgentService 回调，用轻量模型
  // （main-lite，零工具）把本轮对话提炼成 0–3 条长期事实写入记忆库。
  // 未配置 lite 档或调用失败时静默跳过——记忆是增强能力，不阻断对话。
  // 提炼游标存 gateway_metadata（key=memory_distill_cursor:<sessionId>），
  // 进程重启后继续增量提炼，不会重复烧同一段对话。
  const MEMORY_CURSOR_PREFIX = "memory_distill_cursor:";
  const readDistillCursor = (sessionId: string): DistillCursor => {
    const row = db.select().from(gatewayMetadata)
      .where(eq(gatewayMetadata.key, `${MEMORY_CURSOR_PREFIX}${sessionId}`))
      .get();
    if (!row) return { afterCreatedAt: null, afterId: null, attempts: 0 };
    try {
      const parsed = JSON.parse(row.value) as Partial<DistillCursor>;
      return {
        afterCreatedAt: typeof parsed.afterCreatedAt === "string" ? parsed.afterCreatedAt : null,
        afterId: typeof parsed.afterId === "string" ? parsed.afterId : null,
        attempts: Number.isFinite(parsed.attempts) ? Number(parsed.attempts) : 0,
      };
    } catch {
      return { afterCreatedAt: null, afterId: null, attempts: 0 };
    }
  };
  const writeDistillCursor = (sessionId: string, cursor: DistillCursor): void => {
    const value = JSON.stringify(cursor);
    const now = new Date();
    db.insert(gatewayMetadata)
      .values({ key: `${MEMORY_CURSOR_PREFIX}${sessionId}`, value, updatedAt: now })
      .onConflictDoUpdate({ target: gatewayMetadata.key, set: { value, updatedAt: now } })
      .run();
  };
  // 删除会话前的「抢救段」：消息随 session 级联删除，所以先把游标之后的段落落到
  // gateway_metadata（key=memory_distill_captured:<sessionId>），提炼成功才清掉；
  // 进程中途退出也会在下次启动时由 resumeCaptured() 重试。
  const MEMORY_CAPTURED_PREFIX = "memory_distill_captured:";
  const saveCapturedSegment = (sessionId: string, payload: CapturedSegment): void => {
    const now = new Date();
    db.insert(gatewayMetadata)
      .values({ key: `${MEMORY_CAPTURED_PREFIX}${sessionId}`, value: JSON.stringify(payload), updatedAt: now })
      .onConflictDoUpdate({
        target: gatewayMetadata.key,
        set: { value: JSON.stringify(payload), updatedAt: now },
      })
      .run();
  };
  const loadCapturedSegment = (sessionId: string): CapturedSegment | null => {
    const row = db.select().from(gatewayMetadata)
      .where(eq(gatewayMetadata.key, `${MEMORY_CAPTURED_PREFIX}${sessionId}`))
      .get();
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as Partial<CapturedSegment>;
      if (typeof parsed.transcript !== "string" || parsed.transcript.length === 0) return null;
      return {
        transcript: parsed.transcript,
        messages: typeof parsed.messages === "number" ? parsed.messages : 0,
        userTurns: typeof parsed.userTurns === "number" ? parsed.userTurns : 0,
        capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : new Date(0).toISOString(),
        ...(typeof parsed.workspaceId === "string" && parsed.workspaceId.length > 0
          ? { workspaceId: parsed.workspaceId }
          : {}),
      };
    } catch {
      return null;
    }
  };
  const listCapturedSegments = (): string[] => db
    .select({ key: gatewayMetadata.key })
    .from(gatewayMetadata)
    .all()
    .filter((row) => row.key.startsWith(MEMORY_CAPTURED_PREFIX))
    .map((row) => row.key.slice(MEMORY_CAPTURED_PREFIX.length));
  const clearCapturedSegment = (sessionId: string): void => {
    db.delete(gatewayMetadata)
      .where(eq(gatewayMetadata.key, `${MEMORY_CAPTURED_PREFIX}${sessionId}`))
      .run();
  };
  // 会话消息（createdAt + id 升序）；硬切段落时的上文与增量段共用同一份读取。
  const loadSessionMessages = (sessionId: string) => db
    .select({
      id: agentMessages.id,
      role: agentMessages.role,
      content: agentMessages.content,
      createdAt: agentMessages.createdAt,
    })
    .from(agentMessages)
    .where(eq(agentMessages.sessionId, sessionId))
    .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id))
    .all();
  const memoryDistiller = new MemoryDistiller({
    service: memoryService,
    loadMessages: (sessionId, cursor) => {
      const rows = loadSessionMessages(sessionId);
      if (cursor.afterCreatedAt === null) return rows;
      const after = cursor.afterCreatedAt;
      const afterId = cursor.afterId ?? "";
      return rows.filter((row) => {
        const stamp = row.createdAt.toISOString();
        return stamp > after || (stamp === after && row.id > afterId);
      });
    },
    // 硬切段落时往前取 N 轮用户消息作上文（只作理解用，提示词已声明不要重复提炼）。
    loadOverlap: (sessionId, cursor, userTurns) => {
      if (cursor.afterCreatedAt === null || userTurns <= 0) return [];
      const after = cursor.afterCreatedAt;
      const afterId = cursor.afterId ?? "";
      const rows = loadSessionMessages(sessionId);
      const cutIndex = rows.findIndex((row) => {
        const stamp = row.createdAt.toISOString();
        return stamp > after || (stamp === after && row.id > afterId);
      });
      if (cutIndex <= 0) return [];
      let start = cutIndex;
      let seen = 0;
      while (start > 0 && seen < userTurns) {
        start -= 1;
        if (rows[start]?.role === "user") seen += 1;
      }
      return rows.slice(start, cutIndex);
    },
    readCursor: readDistillCursor,
    writeCursor: writeDistillCursor,
    clearCursor: (sessionId) => {
      db.delete(gatewayMetadata)
        .where(eq(gatewayMetadata.key, `${MEMORY_CURSOR_PREFIX}${sessionId}`))
        .run();
    },
    saveCaptured: saveCapturedSegment,
    loadCaptured: loadCapturedSegment,
    listCaptured: listCapturedSegments,
    clearCaptured: clearCapturedSegment,
    generate: generateMemoryText,
    logger: (level, event, fields) => app.log[level](fields ?? {}, event),
  });
  // run 结束：先从 agent_events 里读出这轮「客观出过什么事」，再分两路用——
  // ① 结算上一轮检索的记忆（顺利则隐性确认，出事则跳过）；② 作为坑信号喂给提炼判据。
  // 全程不需要用户做任何操作。
  const collectRunSignals = (runId: string): DistillSignals => {
    const rows = db
      .select({ type: agentEvents.type, payload: agentEvents.payload })
      .from(agentEvents)
      .where(eq(agentEvents.runId, runId))
      .all();
    const failures = new Map<string, number>();
    let toolFailures = 0;
    let retriedAfterFailure = 0;
    for (const row of rows) {
      if (row.type !== "tool.failed" && row.type !== "tool.completed") continue;
      const name = (row.payload as { name?: unknown } | null)?.name;
      const tool = typeof name === "string" && name.length > 0 ? name : "(unknown)";
      if (row.type === "tool.failed") {
        toolFailures += 1;
        failures.set(tool, (failures.get(tool) ?? 0) + 1);
        continue;
      }
      // 失败之后同一个工具又成功了 = 踩了坑并绕过去了，最有价值的经验来源。
      const failedBefore = failures.get(tool) ?? 0;
      if (failedBefore > 0) {
        retriedAfterFailure += 1;
        failures.set(tool, 0);
      }
    }
    return { toolFailures, retriedAfterFailure };
  };
  // 一次 run 结束只登记「段状态」：段满（轮次/字符）立即提炼，否则等空闲。
  agentService.setMemoryDistiller((sessionId, workspaceId, runId) => {
    const signals = collectRunSignals(runId);
    memoryService.settleRun(runId, { failed: signals.toolFailures > 0 });
    memoryDistiller.noteRun(sessionId, workspaceId, signals);
  });
  // 删除会话前抢救：同步落盘，随后异步提炼（不阻塞删除动作）。
  agentService.setMemorySessionCloser((sessionId) => {
    if (!memoryDistiller.captureBeforeDelete(sessionId)) return;
    void memoryDistiller.distillCaptured(sessionId).catch(() => undefined);
  });
  const resumedCaptured = memoryDistiller.resumeCaptured();
  if (resumedCaptured > 0) {
    app.log.info({ sessions: resumedCaptured }, "memory.captured.resumed");
  }
  const searchBackfill = new SearchBackfill(db);
  searchBackfill.schedule();
  // 文档索引回溯（blockIndexMark）：确定性匹配 + LLM 兜底给存量文档补挂来源索引；
  // 安静窗避开用户编辑，零新增标记不写库，未配置 AI 时只跑确定性。
  if (config.documentIndexBackfill?.enabled !== false) {
    const indexBackfillRuntime = config.documentIndexBackfill?.llmEnabled === false
      ? null
      : createIndexBackfillRuntime(config);
    documentIndexBackfillWorker = new DocumentIndexBackfillWorker(
      db,
      documentService,
      indexBackfillRuntime ? new IndexBackfillLlm(indexBackfillRuntime) : null,
      app.log,
      {
        scanIntervalMs: config.documentIndexBackfill?.scanIntervalMs ?? 60_000,
        quietWindowMs: config.documentIndexBackfill?.quietWindowMs ?? 300_000,
        rescanMs: config.documentIndexBackfill?.rescanMs ?? 24 * 60 * 60_000,
      },
    );
    documentIndexBackfillWorker.start();
    app.log.info(
      {
        scanIntervalMs: config.documentIndexBackfill?.scanIntervalMs ?? 60_000,
        quietWindowMs: config.documentIndexBackfill?.quietWindowMs ?? 300_000,
        llm: indexBackfillRuntime !== null,
      },
      "document index backfill worker enabled",
    );
  }
  // 写作风格生成注入已迁移至 doc-writer（doc-writer-subagent-plan §7）：
  await app.register(processingRoutes(sessionTitleService, conversationSuggestionService));
  await app.register(planRoutes(planService, planStream));
  await app.register(workspaceActivityRoutes(workspaceActivityService));
  // 外部 Agent（本机 CLI Agent 等）经 MCP 读写同一个计划池。
  await app.register(planMcpRoutes(planService));
  planLeaseReaper.start();
  await app.register(agentSchedulerRoutes(agentSchedulerService));
  await app.register(agentSchedulerMcpRoutes(agentSchedulerService));
  await app.register(connectorRoutes(connectorCatalog, connectorAuthorization));
  await app.register(connectorSessionRoutes({
    config,
    onSessionChanged: () => {
      void hotReloadAgentRuntimes();
    },
  }));

  // REST 前缀泛化：/v1/connectors/* 为主入口。Fastify v5 路由先于 onRequest
  // （改写 URL 无效），别名经 404 兜底内部转发（app.inject 不走网络，鉴权/解析
  // 全生命周期照常）；旧前缀由插件作用域钩子打弃用头。
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/v1/connectors/")) {
      const rewritten = `/v1/nango-connectors/${request.url.slice("/v1/connectors/".length)}`;
      let body: unknown;
      if (request.method !== "GET" && request.method !== "HEAD") body = request.body;
      const injectOptions: Record<string, unknown> = {
        method: request.method,
        url: rewritten,
        headers: { ...request.headers, "x-internal-alias": "1" },
      };
      if (body !== undefined) injectOptions.payload = body;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- InjectOptions 联合类型在 exactOptionalPropertyTypes 下与动态 payload 不兼容
      const response = await app.inject(injectOptions as any);
      reply.code(response.statusCode);
      for (const [key, value] of Object.entries(response.headers)) {
        if (["content-length", "connection", "transfer-encoding", "date", "keep-alive"].includes(key)) continue;
        reply.header(key, value);
      }
      reply.send(response.rawPayload);
      return;
    }
    reply.code(404).send({ error: "not_found", path: request.url });
  });

  return app;
}
