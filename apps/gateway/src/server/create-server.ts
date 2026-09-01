import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { LogController } from "fastify";
import type { FastifyError } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { bundledAgentDefinitionsDir, type GatewayConfig } from "../config.js";
import { createDatabase } from "../infrastructure/database/client.js";
import { systemRoutes } from "../modules/system/routes.js";
import { AgentEventBroker } from "../modules/agent/event-broker.js";
import { agentRoutes } from "../modules/agent/routes.js";
import { McpConfigManager, mcpRoutes } from "../modules/agent/mcp-routes.js";
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
import { ExternalDocumentProjectionService } from "../modules/documents/external-projections/service.js";
import { externalDocumentProjectionRoutes } from "../modules/documents/external-projections/routes.js";
import {
  createAgentResolver,
  createIngestFilterAgentRuntime,
  registerConnectorSyncAgent,
  registerDiaryAgent,
  registerPrimaryAgent,
  registerTranscriptionSummaryAgent,
} from "../modules/agent/runtime-factory.js";
import { BUILTIN_AGENT_IDS } from "../modules/agent/resolver.js";
import { registerWebSearchAgentIfMissing } from "../modules/agent/runtime-factory.js";
import { loadBuiltinAgentBundle } from "../modules/agent/builtin-bundles.js";
import { OpenAiCompletionAgentRuntime } from "../modules/agent/openai-completion-runtime.js";
import { UnconfiguredAgentRuntime, type AgentRuntime } from "@nxcore/agent-runtime";
import { DocumentServiceError } from "../modules/documents/errors.js";
import { contextRoomRoutes } from "../modules/context-rooms/routes.js";
import { RoomDuplicateService } from "../modules/context-rooms/duplicate-service.js";
import { ContextRoomService } from "../modules/context-rooms/service.js";
import { ContextRoomAgentDispatcher, isSelectionRewriteInvocationAuthorized } from "../modules/context-rooms/room-agent.js";
import { createContextRoomAgentTools } from "../modules/context-rooms/room-agent-tools.js";
import { RoomOverviewService } from "../modules/context-rooms/overview-service.js";
import { createRoomOverviewAgentTools } from "../modules/context-rooms/overview-agent-tools.js";
import { AsrError } from "../modules/asr/errors.js";
import { createAsrProvider } from "../modules/asr/provider-factory.js";
import { asrRoutes } from "../modules/asr/routes.js";
import { AsrService } from "../modules/asr/service.js";
import type { AsrProvider } from "../modules/asr/types.js";
import { MemoryGatewayError } from "../modules/memory/errors.js";
import { memoryRoutes } from "../modules/memory/routes.js";
import { MemoryService } from "../modules/memory/service.js";
import { DataMigrationService } from "../modules/data-migrations/service.js";
import { dataMigrationRoutes } from "../modules/data-migrations/routes.js";
import { filesRoutes } from "../modules/files/routes.js";
import { FilesService } from "../modules/files/service.js";
import { FileClusteringService } from "../modules/files/clustering-service.js";
import { ClipperService } from "../modules/clipper/service.js";
import { clipperRoutes } from "../modules/clipper/routes.js";
import { EmbeddingClient } from "../modules/knowledge/embedding.js";
import { ingestRoutes } from "../modules/ingest/routes.js";
import { IngestService } from "../modules/ingest/service.js";
import { IngestFilterService } from "../modules/ingest/filter-agent.js";
import { FilterRulesStore } from "../modules/ingest/rules.js";
import { FilterInsightJob } from "../modules/ingest/rules-insight.js";
import { DocumentOutboxWorker } from "../modules/ingest/document-outbox-worker.js";
import { DocumentHistoryBackfillWorker } from "../modules/ingest/document-history-backfill-worker.js";
import { loadPolicyOverrides, loadProjectDefaults } from "../modules/ingest/policy.js";
import { knowledgeRoutes } from "../modules/knowledge/routes.js";
import { KnowledgeService } from "../modules/knowledge/service.js";
import { KnowledgeLlm } from "../modules/knowledge/llm.js";
import { cliConnectorRoutes, connectorSyncRoutes, nangoConnectorRoutes } from "../modules/connectors/routes.js";
import { ConnectorMarkdownService } from "../modules/connectors/markdown-service.js";
import { ConnectorSyncService } from "../modules/connectors/service.js";
import { processingRoutes } from "../modules/processing/routes.js";
import { TranscriptionSummaryService } from "../modules/processing/service.js";
import { RealityError } from "../modules/reality/errors.js";
import { realityRoutes } from "../modules/reality/routes.js";
import { RealityService } from "../modules/reality/service.js";
import { perceptionRoutes } from "../modules/perception/routes.js";
import { PerceptionService } from "../modules/perception/service.js";
import { DocumentUnderstandingService } from "../modules/document-understanding/service.js";
import { documentUnderstandingRoutes } from "../modules/document-understanding/routes.js";
import {
  createDocumentAnalysisResultValidator,
  createDocumentUnderstandingTools,
} from "../modules/document-understanding/tools.js";
import { diaryRoutes } from "../modules/diary/routes.js";
import { DiaryService } from "../modules/diary/service.js";
import { AgentSchedulerService } from "../modules/agent-scheduler/service.js";
import { agentSchedulerRoutes } from "../modules/agent-scheduler/routes.js";
import { agentSchedulerMcpRoutes } from "../modules/agent-scheduler/mcp-routes.js";
import { DiaryAgentGenerator } from "../modules/diary/agent-generator.js";
import type { DiarySource } from "../modules/diary/types.js";
import { auth } from "./auth.js";
import { createGatewayLogger } from "./logger.js";
import "./types.js";
import { createConnectorDatabase } from "../infrastructure/connectors/client.js";
import { ConnectorRepository } from "../modules/connectors/repository.js";
import { ConnectorManager } from "../modules/connectors/manager.js";
import { ConnectorDomainProjection, backfillDomainProjection, rewriteConnectorRefIdentities } from "../modules/connectors/domain-projection.js";
import { SYNC_PROVIDERS, assertSyncProvidersValid } from "../modules/connectors/sync-providers/index.js";
import { SyncEngine } from "../modules/connectors/sync-engine.js";
import { NangoExecutor } from "../modules/connectors/nango-executor.js";
import { NangoAuthorizationService } from "../modules/connectors/nango-authorization.js";
import { bootstrapNangoWhenReady } from "../modules/connectors/nango-bootstrap.js";
import { ConnectorDocumentStore } from "../modules/connectors/document-store.js";
import { SubagentRegistry } from "../modules/subagents/registry.js";
import { SubagentRuntimeManager } from "../modules/subagents/runtime-manager.js";
import { SubagentOrchestrator } from "../modules/subagents/orchestrator.js";
import { createSubagentPiTools } from "../modules/subagents/tools.js";
import { LocalAgentRuntimeRegistry } from "../modules/local-agents/runtime-registry.js";
import { subagentRoutes } from "../modules/subagents/routes.js";
import { AgentStatusService } from "../modules/agent/status-service.js";
import { createReferencedAgentConversationTools } from "../modules/agent/reference-tools.js";
import { RuntimeConfigManager } from "../runtime-config.js";
import { runtimeConfigRoutes } from "../modules/runtime-config/routes.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { OpenAiCompatibleVlmClient } from "../modules/perception/vlm-client.js";
import { isPrimaryConfigured as isRuntimePrimaryConfigured } from "../modules/runtime-config/validate.js";
import { DEFAULT_SECRET_STORE_MASTER_KEY, SecretStore } from "../security/secret-store.js";
import { redactSecrets, redactText } from "../security/secret-redaction.js";
import { ExternalCallBudgetService } from "../modules/external-calls/service.js";
import { externalCallRoutes } from "../modules/external-calls/routes.js";

function applyRuntimeConfig(config: GatewayConfig, runtime: RuntimeConfig): void {
  // runtime config（尤其默认文件）里的 "" 是「未配置」占位，不是「清空」指令；
  // 空串直接覆盖会把 env 兜底（如 NXCORE_MEMORY_BASE_URL）打掉，导致
  // MemoryCoreClient baseUrl 为空、fetch 相对路径报 Failed to parse URL。
  const apply = (target: Record<string, unknown> | null | undefined, source: unknown) => {
    if (!target || !source || typeof source !== "object") return;
    const value = source as Record<string, unknown>;
    for (const key of ["provider", "model", "baseUrl", "api", "apiKey", "maxTokens", "contextWindow", "temperature", "reasoning"]) {
      if (value[key] !== undefined && value[key] !== "") target[key] = value[key];
    }
  };
  apply(config.pi as unknown as Record<string, unknown> | null, runtime.primary);
  apply(config.backgroundPi as unknown as Record<string, unknown> | null, runtime.background);
  apply(config.cursorCompletionPi as unknown as Record<string, unknown> | null, runtime.cursorCompletion);
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
  // ASR（仅 aliyun provider）：runtime 标量 + OSS 必填项齐全可直接构造
  // （含 OSS——env 从未应用 runtime.asr.oss，而阿里云提交转写无 OSS 直接抛错）；
  // 仅标量齐全时保持补丁行为，env 配置的 OSS 保留。
  const runtimeAsr = runtime.asr as Record<string, unknown> | undefined;
  const asrText = (key: string): string =>
    runtimeAsr && typeof runtimeAsr[key] === "string" ? (runtimeAsr[key] as string).trim() : "";
  const runtimeOss = runtimeAsr?.oss as Record<string, unknown> | undefined;
  const ossText = (key: string): string =>
    runtimeOss && typeof runtimeOss[key] === "string" ? (runtimeOss[key] as string).trim() : "";
  if (asrText("apiKey") && asrText("baseUrl") && asrText("model")
    && ossText("region") && ossText("bucket") && ossText("accessKeyId") && ossText("accessKeySecret")) {
    config.asr = {
      apiKey: asrText("apiKey"),
      baseUrl: asrText("baseUrl"),
      model: asrText("model"),
      oss: {
        region: ossText("region"),
        bucket: ossText("bucket"),
        accessKeyId: ossText("accessKeyId"),
        accessKeySecret: ossText("accessKeySecret"),
        ...(ossText("stsToken") ? { stsToken: ossText("stsToken") } : {}),
        prefix: ossText("prefix") || "nxcore-asr",
      },
    };
  } else if (config.asr && runtimeAsr) {
    for (const key of ["provider", "baseUrl", "model", "apiKey"] as const) {
      if (asrText(key)) (config.asr as unknown as Record<string, unknown>)[key] = asrText(key);
    }
  }
  // memory / knowledge 不参与 runtime config 覆盖：桌面端两者都是主进程
  // supervisor 托管的本地服务（baseUrl 127.0.0.1，apiKey 每次启动随机轮换），
  // 云端下发的凭据必然对不上本地实例（401）；NXCORE_MEMORY_*/NXCORE_KNOWLEDGE_*
  // env 由桌面主进程在 spawn gateway 时注入，永远比云端值准确。
  // 唯一例外：knowledge.embedding 四要素齐全时覆盖 env 消歧/聚类的
  // embedding 端点——它指向外部 LLM 服务（非托管本地实例），与 env 语义
  // 完全一致（NXCORE_KNOWLEDGE_EMBEDDING_* 的 runtime-config 版本）。
  const embedding = runtime.knowledge?.embedding as Record<string, unknown> | undefined;
  if (embedding && config.knowledge) {
    const embeddingText = (key: string): string =>
      typeof embedding[key] === "string" ? (embedding[key] as string).trim() : "";
    const baseUrl = embeddingText("baseUrl");
    const apiKey = embeddingText("apiKey");
    const model = embeddingText("model");
    if (baseUrl && apiKey && model) {
      config.knowledge.embeddingLlm = { baseUrl, apiKey, model };
      config.knowledge.embeddingModel = model;
    }
  }
  // 抽取 LLM（knowledge.llm）：runtime 四要素齐全时覆盖；未配置时回退
  // runtime primary——env 时代 NXCORE_KNOWLEDGE_LLM_* 缺省回退 NXCORE_AI_*
  // （config.ts ⑤ 段）的 runtime-config 等价物，否则 env 清理后 wiki 抽取
  // 会静默降级为启发式聚类。
  if (config.knowledge) {
    const runtimeKnowledgeLlm = runtime.knowledge?.llm as Record<string, unknown> | undefined;
    const llmText = (source: Record<string, unknown> | undefined, key: string): string =>
      source && typeof source[key] === "string" ? (source[key] as string).trim() : "";
    const llmBaseUrl = llmText(runtimeKnowledgeLlm, "baseUrl") || llmText(runtime.primary as Record<string, unknown> | undefined, "baseUrl");
    const llmApiKey = llmText(runtimeKnowledgeLlm, "apiKey") || llmText(runtime.primary as Record<string, unknown> | undefined, "apiKey");
    const llmModel = llmText(runtimeKnowledgeLlm, "model") || llmText(runtime.primary as Record<string, unknown> | undefined, "model");
    if (llmBaseUrl && llmApiKey && llmModel) {
      config.knowledge.llm = { baseUrl: llmBaseUrl, apiKey: llmApiKey, model: llmModel };
    }
  }
}

/** 从 GatewayConfig 构造 gateway 侧 embedding 客户端（未配置返回 null）。 */
function embeddingFromConfig(
  config: GatewayConfig,
): { client: EmbeddingClient; model: string } | null {
  const llm = config.knowledge?.embeddingLlm;
  const model = config.knowledge?.embeddingModel;
  if (!llm || !model) return null;
  return { client: new EmbeddingClient(llm, model), model };
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

export interface ServerOverrides {
  asrProvider?: AsrProvider | null;
}

export async function createServer(config: GatewayConfig, overrides: ServerOverrides = {}) {
  const gatewayLogger = await createGatewayLogger(config.dataDir, config.logLevel);
  // Fastify emits one INFO line for both sides of every request. Keep those
  // access logs disabled by default; warn/error paths still reach the logger.
  const gatewayHttpLogLevel = process.env.NXCORE_GATEWAY_HTTP_LOG_LEVEL?.trim().toLowerCase() ?? "warn";
  const disableRequestLogging = gatewayHttpLogLevel !== "debug" && gatewayHttpLogLevel !== "info";
  const app = Fastify({
    loggerInstance: gatewayLogger.logger,
    logController: new LogController({ disableRequestLogging }),
    routerOptions: {
      // knowledge 文件路由的 id 可能是 caller_ref（如 connector:provider:<uuid>:<docId>），
      // URL 编码后超 Fastify 默认 100 上限被拒。500 覆盖最长组合。
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
    userId: config.externalCallUserId ?? config.cliConnectorSyncOwnerId ?? "local-user",
    workspaceId: config.externalCallWorkspaceId ?? "local-workspace",
  });
  const runtimeConfigManager = new RuntimeConfigManager(db, secretStore, undefined, config.webSearch
    ? { provider: "openai-compatible", api: "openai-completions", ...config.webSearch }
    : null);
  const initialRuntimeSnapshot = runtimeConfigManager.snapshot();
  applyRuntimeConfig(config, initialRuntimeSnapshot.config);
  const redactedRuntimeSnapshot = runtimeConfigManager.snapshot(true);
  const configSource = initialRuntimeSnapshot.selectedSource === "user"
    ? "local"
    : initialRuntimeSnapshot.selectedSource === "saas" ? "saas" : "env";
  app.log.info({
    event: "runtime_config.selected",
    source: configSource,
    runtimeSource: initialRuntimeSnapshot.selectedSource,
    availableSources: initialRuntimeSnapshot.availableSources,
    configVersion: initialRuntimeSnapshot.configVersion,
    primaryConfigured: isRuntimePrimaryConfigured(initialRuntimeSnapshot.config),
    memoryConfigured: Boolean(config.memory),
    knowledgeConfigured: Boolean(config.knowledge),
    configJson: JSON.stringify(redactedRuntimeSnapshot.config),
  }, "runtime config selected");
  const nangoConnectorConfig = config.nangoConnector ?? { enabled:false, databasePath:resolve(config.dataDir,"database","connectors.sqlite"), nangoUrl:"", nangoSecret:"", gmailConfigKey:"", outlookConfigKey:"", googleDocsConfigKey:"", notionConfigKey:"", googleCalendarConfigKey:"", googleClientId:"", googleClientSecret:"", notionClientId:"", notionClientSecret:"", outlookClientId:"", outlookClientSecret:"", pollingIntervalMs:300_000, providerConfigKeys:{} };
  // 阶段二：注册表启动自检（补偿 union 放宽后丢失的编译期穷尽性）——违例拒启。
  assertSyncProvidersValid();
  // Nango 自举（必要时创建 API key、按 .env 凭据补建 Google/Notion integration）。
  // 桌面端 Gateway 先于托管 Nango ready（首次启动含依赖安装 + 构建），启动时同步
  // 自举必失败且 placeholder secret 一直生效；改为后台自举：立即开始等待 Nango
  // ready（最长 10 分钟，覆盖冷启动）并自举，secret 惰性 getter 在完成前返回
  // 配置值，完成后自动切换到自举结果。
  let nangoSecretResolved: string | null = null;
  const isNangoSecretFormatValid = (secret: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(secret.trim());
  const configuredNangoSecretValid = isNangoSecretFormatValid(nangoConnectorConfig.nangoSecret);
  const nangoBootstrapPending = process.env.NXCORE_NANGO_BOOTSTRAP_PENDING === "1";
  const resolveNangoSecret = (): string =>
    nangoSecretResolved ?? (configuredNangoSecretValid ? nangoConnectorConfig.nangoSecret : "");
  const pollingIntervalMs = "pollingIntervalMs" in nangoConnectorConfig
    ? nangoConnectorConfig.pollingIntervalMs
    : 300_000;
  if (nangoConnectorConfig.enabled) {
    void bootstrapNangoWhenReady(nangoConnectorConfig)
      .then((secret) => {
        if (isNangoSecretFormatValid(secret)) {
          nangoSecretResolved = secret;
          // 引擎放行 OAuth 源（轮询循环自 M3 起常开，由 canServe 门控跳过未就绪源）。
          nangoSyncEngine.setNangoReady(true);
          app.log.info({ module: "nango-bootstrap" }, "Nango secret resolved after deferred bootstrap");
        } else {
          app.log.warn({ module: "nango-bootstrap" }, "Nango bootstrap returned no valid UUID v4 secret; connector polling remains disabled");
        }
      })
      .catch((error) => {
        app.log.warn(
          { module: "nango-bootstrap", error: error instanceof Error ? error.message : String(error) },
          "Deferred Nango bootstrap failed; falling back to configured secret",
        );
      });
  }
  const nangoConnectorDb = createConnectorDatabase(nangoConnectorConfig.enabled ? nangoConnectorConfig.databasePath : ":memory:");
  const nangoExecutor = nangoConnectorConfig.enabled
    ? new NangoExecutor(nangoConnectorConfig.nangoUrl, resolveNangoSecret)
    : null;
  // 阶段三：拉取引擎（nango 代理 + direct 直连双路）；direct 凭据取连接的 credentialsRef。
  const nangoSyncEngine = new SyncEngine(
    nangoExecutor,
    (connection) => connection.credentialsRef ?? null,
  );
  const nangoConnectorManager = new ConnectorManager(
    new ConnectorRepository(nangoConnectorDb.sqlite),
    nangoExecutor,
    nangoConnectorConfig.enabled ? new ConnectorDocumentStore(resolve(config.dataDir, "connectors", "documents")) : null,
    nangoSyncEngine,
  );
  // Nango 连接器的 agent 工具（连接发现 / 触发同步 / 只读代理请求）。
  const nangoAgentTools = nangoExecutor
    ? { manager: nangoConnectorManager, executor: nangoExecutor }
    : null;
  const nangoConnectorAuthorization = nangoConnectorConfig.enabled && "providerConfigKeys" in nangoConnectorConfig
    ? new NangoAuthorizationService(
        nangoConnectorConfig.nangoUrl,
        resolveNangoSecret,
        // 阶段二：provider → configKey 装配由注册表驱动（新增 provider 免改此处）。
        Object.fromEntries(SYNC_PROVIDERS.map((definition) => [
          definition.provider,
          nangoConnectorConfig.providerConfigKeys[definition.provider]
            ?? definition.auth.nango?.configKeyDefault
            ?? "",
        ])),
        nangoConnectorManager,
      )
    : undefined;
  // When the configured value is a bootstrap placeholder, wait for the
  // dashboard API key before polling. Nango rejects non-UUID secrets with a
  // noisy 401 on every scheduled sync.
  if (nangoConnectorConfig.enabled) {
    // 轮询常开：引擎门控在 secret 未就绪期间跳过 OAuth 源（无 401 噪音），
    // direct 源（WebCal 订阅）不受 Nango 冷启动影响、立即按周期同步。
    nangoSyncEngine.setNangoReady(configuredNangoSecretValid && !nangoBootstrapPending);
    nangoConnectorManager.startPolling(pollingIntervalMs);
  }
  // 阶段一域投影（connector-platform-refactor-plan）：Nango 拉取的邮件/日程
  // 与 CLI 推送路径同落主库 connector_* 域表，Room 读侧单轨；启动后延迟 1s
  // 幂等回填 connectors.sqlite 存量（唯一键 upsert，重复执行产出 unchanged）。
  const connectorDomainOwner = config.connectorSyncOwnerId ?? "local-user";
  nangoConnectorManager.setDomainProjection(new ConnectorDomainProjection(db, connectorDomainOwner));
  if (nangoConnectorConfig.enabled) {
    const backfillTimer = setTimeout(() => {
      try {
        const summary = backfillDomainProjection(db, nangoConnectorManager.repository, connectorDomainOwner);
        if (summary.mail + summary.calendar + summary.failures > 0)
          app.log.info({ module: "connector-domain-backfill", ...summary }, "Connector domain backfill applied");
        // M4：回填保证域行存在后，把六张身份表的 connector ref 原地改写为域行 id
        // （幂等；解析失败的 ref 留给读侧兜底通道，只计数）。
        const rewrite = rewriteConnectorRefIdentities(db);
        if (rewrite.refs > 0)
          app.log.info({ module: "connector-identity-rewrite", ...rewrite }, "Connector identity rewrite applied");
      } catch (error) {
        app.log.warn(
          { module: "connector-domain-backfill", error: error instanceof Error ? error.message : String(error) },
          "Connector domain backfill failed; incremental sync will keep projecting new records",
        );
      }
    }, 1_000);
    backfillTimer.unref?.();
  }

  // /v1/runtime-config/secrets 是唯一允许真密钥出站的端点：主进程派生托管
  // 子进程 env 用（token 鉴权，token 只在主进程）；若在此脱敏，子进程会拿
  // "[REDACTED]" 当 key 起服务并静默 401。其余响应一律按键名/注册密钥脱敏。
  app.addHook("preSerialization", async (request, _reply, payload) => {
    if (request.routeOptions.url === "/v1/runtime-config/secrets") return payload;
    return redactSecrets(payload);
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "request failed");
    if (error instanceof AsrError) {
      await reply.code(error.statusCode).send({
        error: error.code,
        message: redactText(error.message),
        requestId: request.id,
      });
      return;
    }
    if (error instanceof MemoryGatewayError || error instanceof RealityError) {
      await reply.code(error.statusCode).send({
        error: error.code,
        message: redactText(error.message),
        requestId: request.id,
      });
      return;
    }
    if (error instanceof DocumentServiceError) {
      await reply.code(error.statusCode).send({
        error: error.code,
        message: redactText(error.message),
        ...error.details,
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
  const memoryService = new MemoryService(config.memory, app.log, { db, dataDir: config.dataDir });
  const contextRoomService = new ContextRoomService(db);
  const roomOverviewService = new RoomOverviewService(db, contextRoomService);
  const documentEventBroker = new DocumentEventBroker();
  const documentOperationService = new DocumentOperationService(db, documentEventBroker);
  const documentService = new DocumentService(db, documentEventBroker, (document) => {
    void memoryService.captureDocumentCreation(document).catch((error: unknown) => {
      app.log.warn({ err: error, documentId: document.documentId }, "document memory capture failed");
    });
  }, (patch) => {
    void memoryService.captureSelectionRewrite({
      roomId: patch.roomId,
      documentId: patch.documentId,
      documentTitle: patch.title,
      instruction: patch.instruction,
      originalText: patch.originalText,
      replacementText: patch.replacementText,
    }).catch((error: unknown) => {
      app.log.warn({ err: error, operationId: patch.operationId }, "document rewrite memory capture failed");
    });
  }, (documentId, currentVersion) => (
    documentOperationService.prepareExternalVersionAdvance(documentId, currentVersion)
  ), (error, documentId, currentVersion) => {
    app.log.warn({ err: error, documentId, currentVersion }, "document after-commit observer failed");
  });
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
  const documentMcpHost = new DocumentMcpHost(
    documentService,
    contextRoomService,
    undefined,
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
  // knowledge 模块先行构建：pi runtime 的会话级 Room wiki 解析依赖它。
  const knowledgeService = new KnowledgeService(
    db,
    {
      baseUrl: config.knowledge?.baseUrl ?? "",
      serviceId: config.knowledge?.serviceId ?? "everroom",
      teamId: config.knowledge?.teamId ?? "everroom",
      dataDir: config.dataDir,
      roomWikisEnabled: config.knowledge?.roomWikisEnabled ?? false,
      ingestDebounceMs: config.knowledge?.ingestDebounceMs ?? 600_000,
      routerEnabled: config.knowledge?.routerEnabled ?? false,
      entityPromoteScore: config.knowledge?.entityPromoteScore ?? 2.4,
      entityPromoteSources: config.knowledge?.entityPromoteSources ?? 3,
      roomRelationMinScore: config.knowledge?.roomRelationMinScore ?? 1,
      mergeAutoDice: config.knowledge?.mergeAutoDice ?? 0.75,
      mergeJudgeDice: config.knowledge?.mergeJudgeDice ?? 0.6,
      llm: config.knowledge?.llm ?? null,
      embeddingLlm: config.knowledge?.embeddingLlm ?? null,
      embeddingModel: config.knowledge?.embeddingModel ?? "",
    },
    app.log,
    agentResolver,
  );
  const roomDuplicateService = new RoomDuplicateService(db, {
    judgeIdentity: (a, b) => knowledgeService.judgeRoomIdentity(a, b),
    mergeKnowledge: (sourceRoomId, targetRoomId) => knowledgeService.mergeRoomKnowledge(sourceRoomId, targetRoomId),
    rebuildRelations: () => knowledgeService.rebuildRoomRelations(),
    wikiFileCount: (roomId) => knowledgeService.roomWikiFileCount(roomId),
  });
  contextRoomService.setDuplicateService(roomDuplicateService);
  knowledgeService.setRoomDuplicateIndexTrigger(() => roomDuplicateService.requestRebuild());
  // 手动建 Room：enrich 实体回写时认领到本 Room，使后续资料路由能命中（与推荐晋升同语义）
  contextRoomService.setRoomEntityClaimer((roomId, entities) =>
    knowledgeService.claimRoomEntities(roomId, entities));
  roomDuplicateService.initialize();
  const cliConnectorSyncService = new ConnectorSyncService(db, config, app.log);
  let cliConnectorMarkdownService: ConnectorMarkdownService | null = null;
  registerConnectorSyncAgent(agentResolver, config, cliConnectorSyncService);
  if (agentResolver.has(BUILTIN_AGENT_IDS.connectorSync)) {
    cliConnectorSyncService.attachAgentRuntime(agentResolver.resolve(BUILTIN_AGENT_IDS.connectorSync), {
      disposeRuntime: false,
    });
  }
  await cliConnectorSyncService.initialize();
  const subagentConfig = config.subagents ?? {
    enabled: true,
    definitionsDir: bundledAgentDefinitionsDir(),
    runtimeDir: resolve(config.dataDir, "agent", "subagents"),
    defaultTimeoutMs: 300_000,
    maxConcurrent: 4,
  };
  const subagentRegistry = new SubagentRegistry(
    db,
    subagentConfig,
    config.pi?.mcp?.mcpServers ?? {},
    app.log,
  );
  await subagentRegistry.initialize();
  const subagentRuntimeManager = new SubagentRuntimeManager(config, subagentConfig, externalCalls);
  // context-room 子 Agent 的网关只读工具：记忆检索 + Room 文档上下文。
  // registerAgentTools 必须发生在任何 acquire 之前（首次 dispatch 前）。
  subagentRuntimeManager.registerAgentTools(
    "context-room",
    () => createContextRoomAgentTools({ db, memory: memoryService, overview: roomOverviewService }),
  );
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
  const contextRoomAgentDispatcher = new ContextRoomAgentDispatcher(subagentOrchestrator);
  contextRoomService.setRoomAgentDispatcher(contextRoomAgentDispatcher, (bindings, message) => {
    app.log.warn(bindings, message);
  });
  roomOverviewService.setRoomAgentDispatcher(contextRoomAgentDispatcher);
  let resolveFileMarkdown: ((fileId: string) => Promise<string | null>) | undefined;
  let resolveAgentConversation: ((threadId: string, query: string) => Promise<string | null>) | undefined;
  const recoveredSubagentInvocations = subagentOrchestrator.initialize();
  if (recoveredSubagentInvocations > 0) {
    app.log.info({ recoveredSubagentInvocations }, "subagent invocations interrupted after restart");
  }
  registerPrimaryAgent(agentResolver, config, documentMcpHost, {
    externalCalls,
    tools: [
      ...createRoomOverviewAgentTools(roomOverviewService),
      ...(subagentConfig.enabled
        ? createSubagentPiTools(subagentRegistry, subagentOrchestrator, {
            resolveFileMarkdown: async (fileId) => resolveFileMarkdown?.(fileId) ?? null,
         })
        : []),
      ...createNotificationPiTools(notificationMcpHost),
      ...createReferencedAgentConversationTools(async (threadId, query) => (
        resolveAgentConversation?.(threadId, query) ?? null
      )),
    ],
    // Room 级 wiki：会话按 roomId 解析本 Room wiki；未命中回退配置默认集。
    ...(config.knowledge?.roomWikisEnabled
      ? {
          resolveKnowledgeWikiIds: async (input) => {
            if (!input.roomId) return [];
            const wikiId = knowledgeService.resolveRoomWikiId(input.roomId);
            return wikiId ? [wikiId] : [];
          },
        }
      : {}),
  }, cliConnectorSyncService, nangoAgentTools);
  const agentRuntime = agentResolver.resolve(BUILTIN_AGENT_IDS.primary);
  const localAgentRuntimeRegistry = new LocalAgentRuntimeRegistry();
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
    },
    "agent runtime configured",
  );
  const agentService = new AgentService(
    db,
    agentRuntime,
    new AgentEventBroker(),
    app.log,
    contextRoomService,
    documentService,
    documentMcpHost,
    config.cliConnectorAgentMode ?? "direct",
    false,
    (target) => localAgentRuntimeRegistry.resolve(target),
  );
  await agentService.initialize();
  registerTranscriptionSummaryAgent(agentResolver, config);
  const backgroundAgentRuntime = agentResolver.resolve(BUILTIN_AGENT_IDS.transcriptionSummary);
  app.log.info(
    {
      runtimeId: backgroundAgentRuntime.id,
      ...(config.backgroundPi
        ? {
            provider: config.backgroundPi.provider,
            model: config.backgroundPi.model,
            maxTokens: config.backgroundPi.maxTokens,
          }
        : {}),
    },
    "background transcription runtime configured",
  );
  const transcriptionSummaryService = new TranscriptionSummaryService(backgroundAgentRuntime, false);
  let asrProvider = Object.hasOwn(overrides, "asrProvider")
    ? overrides.asrProvider ?? null
    : createAsrProvider(config, app.log);
  const asrService = new AsrService(db, config.asrInputDir, asrProvider, app.log);
  // ingest 过滤器/洞察 runtime 的统一构造（boot 与 onChange 共用；下方声明
  // 后回填，emit 只从 HTTP handler 触发，届时早已初始化）。
  let buildIngestFilterRuntime: () => AgentRuntime | null = () => null;
  runtimeConfigManager.onChange((snapshot) => {
    app.log.info({
      event: "runtime_config.selected",
      source: snapshot.selectedSource,
      availableSources: snapshot.availableSources,
      configVersion: snapshot.configVersion,
      primaryConfigured: isRuntimePrimaryConfigured(snapshot.config),
      runtimeSections: Object.keys(snapshot.config).filter((key) =>
        ["primary", "background", "cursorCompletion", "asr", "vlm", "webSearch", "memory", "knowledge"].includes(key)),
    }, "runtime config selected");
    applyRuntimeConfig(config, snapshot.config);
    // embedding 端点热替换（runtime knowledge.embedding 覆盖 env）。
    const embedding = embeddingFromConfig(config);
    knowledgeService.replaceEmbedding(embedding ? { client: embedding.client, model: embedding.model } : null);
    fileClusteringService.replaceEmbedding(embedding?.client ?? null, embedding?.model ?? null);
    asrProvider = createAsrProvider(config, app.log);
    asrService.replaceProvider(asrProvider);
    // webSearch：boot 时 env 未配、runtime config 保存后才注册的场景。
    if (registerWebSearchAgentIfMissing(agentResolver, config)) {
      app.log.info("web search agent registered from runtime config");
    }
    // knowledge agent：boot 时 env 未配 knowledge.llm、runtime config
    // （或 primary 回退）补齐后注册。
    if (config.knowledge?.llm && !agentResolver.has(BUILTIN_AGENT_IDS.knowledge)) {
      const id = BUILTIN_AGENT_IDS.knowledge;
      const bundle = loadBuiltinAgentBundle(bundledAgentDefinitionsDir(), id);
      const directories = join(config.dataDir, "agent", "runtimes", id);
      agentResolver.register({
        id,
        name: bundle.name,
        description: bundle.description,
        configDirectory: join(directories, "config"),
        kind: "builtin",
      }, () => {
        const llm = config.knowledge?.llm;
        if (!llm) return new UnconfiguredAgentRuntime(id);
        return new OpenAiCompletionAgentRuntime({
          runtimeId: id,
          ...llm,
          systemPrompt: bundle.systemPrompt,
          skillPrompts: bundle.skillPrompts,
          temperature: 0.1,
          maxTokens: 4_096,
          timeoutMs: 60_000,
          sessionsDir: join(directories, "sessions"),
          workingDirectory: join(directories, "workspace"),
          agentDirectory: join(directories, "config"),
        });
      });
      app.log.info("knowledge agent registered from runtime config");
    }
    // 抽取/判定 LLM 同步热替换：KnowledgeService 构造于 runtime config 到达
    // 之前，boot 时 llm 冻结为 null——不替换的话路由永远走「未识别」出口。
    if (config.knowledge?.llm) {
      knowledgeService.replaceLlm(config.knowledge.llm);
    }
    void (async () => {
      try {
        const primary = agentResolver.reload(BUILTIN_AGENT_IDS.primary);
        void agentService.replaceRuntime(primary.current);
        const background = agentResolver.reload(BUILTIN_AGENT_IDS.transcriptionSummary);
        void transcriptionSummaryService.replaceRuntime(background.current);
        for (const agentId of [BUILTIN_AGENT_IDS.cursorCompletion, BUILTIN_AGENT_IDS.webSearch, BUILTIN_AGENT_IDS.knowledge]) {
          if (!agentResolver.has(agentId)) continue;
          const { previous } = agentResolver.reload(agentId);
          await previous?.dispose();
        }
        // 连接器同步 agent（初始 attach 见下方 registerConnectorSyncAgent 处）。
        if (agentResolver.has(BUILTIN_AGENT_IDS.connectorSync)) {
          const connector = agentResolver.reload(BUILTIN_AGENT_IDS.connectorSync);
          cliConnectorSyncService.replaceAgentRuntime(connector.current);
          await connector.previous?.dispose();
        }
        // 过滤器/洞察 job 持有的冻结 runtime 同步热替换。
        const nextFilterRuntime = buildIngestFilterRuntime();
        ingestFilterService?.replaceRuntime(nextFilterRuntime);
        filterInsightJob?.replaceRuntime(nextFilterRuntime);
        // 子 Agent 缓存作废（下次 acquire 以新 backgroundPi 重建）。
        await subagentRuntimeManager.invalidate();
      } catch (error) {
        app.log.error({ error: error instanceof Error ? error.message : String(error) }, "runtime config reload failed");
      }
    })();
  });
  // 文件管理中心（U9 唯一字节入口）：对象库 + uploaded/parsed 登记；
  // 删除级联经钩子回调 knowledge（wiki 清理）与 memory（文档删除）。
  const filesService = new FilesService(db, config.dataDir);
  filesService.initializeCatalog();
  const dataMigrationService = new DataMigrationService(db, sqlite, memoryService);
  dataMigrationService.setFilesService(filesService);
  resolveAgentConversation = (threadId, query) => dataMigrationService.buildReferenceContext(threadId, query);
  agentService.setExternalConversationResolver(dataMigrationService);
  agentService.setFilesService(filesService);
  const clipperService = new ClipperService(db, filesService, config.dataDir, createVlmProvider(config));
  await clipperService.initialize();
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
    clipperService.replaceVisualProvider(visualProvider);
  });
  subagentRuntimeManager.registerAgentTools(
    "multimodal-document-parser",
    () => createDocumentUnderstandingTools(documentUnderstandingService),
  );
  subagentRuntimeManager.registerAgentResultValidator(
    "multimodal-document-parser",
    createDocumentAnalysisResultValidator(documentUnderstandingService),
  );
  cliConnectorSyncService.setFilesService(filesService);
  const fileClusteringService = new FileClusteringService(
    db,
    agentResolver.has(BUILTIN_AGENT_IDS.knowledge) ? agentResolver : null,
    embeddingFromConfig(config)?.client ?? null,
    config.knowledge?.embeddingModel ?? null,
  );
  filesService.setVersionClassifier((fileEntryId, fileVersionId) => {
    fileClusteringService.enqueue(fileEntryId, fileVersionId);
  });
  fileClusteringService.initialize();
  const diaryGenerator = config.agentRuntime !== "fake" && config.backgroundPi
    ? new DiaryAgentGenerator(config.backgroundPi.model || "diary-agent", app.log)
    : null;
  if (diaryGenerator) {
    registerDiaryAgent(agentResolver, config, diaryGenerator);
    diaryGenerator.attachRuntime(agentResolver.resolve(BUILTIN_AGENT_IDS.diary));
  }
  const diaryMemory = {
    query: async ({ start, end }: { start: Date; end: Date }): Promise<DiarySource[]> => {
      if (!memoryService.enabled) return [];
      const items: Awaited<ReturnType<typeof memoryService.listAtomic>>["items"] = [];
      // Keep the diary manifest bounded. A large imported memory set can
      // otherwise exhaust the Agent context before it returns JSON.
      const page = await memoryService.listAtomic({
        // MemoryCore caps atomic pagination at 100.
        limit: 30,
        offset: 0,
        timeStart: start.toISOString(),
        timeEnd: end.toISOString(),
      });
      items.push(...page.items);
      return items.map((item) => ({
        sourceId: `memory:${item.id}`,
        kind: "memory" as const,
        version: item.updatedAt,
        occurredAt: item.createdAt,
        timeBasis: "memory_created",
        fingerprint: JSON.stringify([item.id, item.updatedAt, item.content, item.background]),
        evidenceSummary: item.content.slice(0, 500),
        content: [item.content, item.background].filter(Boolean).join("\n\n"),
      }));
    },
  };
  const diaryService = new DiaryService(db, {
    logger: app.log,
    scheduleManagedExternally: true,
    ...(diaryGenerator ? { generator: diaryGenerator } : {}),
    memory: diaryMemory,
  });
  if (diaryGenerator) {
    runtimeConfigManager.onChange(() => {
      if (!agentResolver.has(BUILTIN_AGENT_IDS.diary)) return;
      const { current } = agentResolver.reload(BUILTIN_AGENT_IDS.diary);
      void diaryGenerator.replaceRuntime(current);
    });
  }
  const agentSchedulerService = new AgentSchedulerService(db, diaryService, agentService);
  agentSchedulerService.initialize();
  diaryService.initialize();
  const perceptionService = new PerceptionService(db, filesService, createVlmProvider(config), app.log, (at) => diaryService.markStaleAt(at));
  runtimeConfigManager.onChange(() => perceptionService.replaceVlm(createVlmProvider(config)));
  const purgedUnsupportedFiles = await filesService.purgeUnsupportedFiles();
  if (purgedUnsupportedFiles > 0) {
    app.log.info({ purgedUnsupportedFiles }, "purged unsupported JSON file records");
  }
  const realityService = new RealityService(db, config.asrInputDir, app.log);
  const recoveredCaptures = realityService.recoverInterruptedCaptures();
  if (recoveredCaptures > 0) {
    app.log.info({ recoveredCaptures }, "interrupted reality captures recovered");
  }
  // Knowledge consumes durable jobs; document commits enter Ingest through the outbox worker.
  if (config.knowledge?.roomWikisEnabled) {
    knowledgeService.start();
    app.log.info(
      {
        debounceMs: config.knowledge.ingestDebounceMs,
        router: config.knowledge.routerEnabled,
        embedding: Boolean(config.knowledge.embeddingModel),
      },
      "knowledge entity-room routing enabled",
    );
  }
  let documentOutboxWorker: DocumentOutboxWorker | null = null;
  let documentHistoryBackfillWorker: DocumentHistoryBackfillWorker | null = null;
  app.addHook("onClose", async () => {
    // Stop producers while all ingest/classification dependencies are still alive.
    await clipperService.dispose();
    await filesService.dispose();
    await fileClusteringService.dispose();
    await nangoConnectorManager.dispose();
    nangoConnectorDb.close();
    clearInterval(documentOperationExpiryTimer);
    await agentService.dispose();
    await localAgentRuntimeRegistry.dispose();
    await subagentOrchestrator.dispose();
    await transcriptionSummaryService.dispose();
    await documentMcpHost.close();
    await documentOutboxWorker?.dispose();
    await documentHistoryBackfillWorker?.dispose();
    filterInsightJob?.dispose();
    ingestService.disposeFilter();
    await cliConnectorSyncService.dispose();
    await cliConnectorMarkdownService?.dispose();
    await perceptionService.dispose();
    await agentSchedulerService.dispose();
    await diaryService.dispose();
    roomDuplicateService.dispose();
    knowledgeService.dispose();
    await asrService.dispose();
    await agentResolver.dispose();
    await notificationMcpHost.close();
    sqlite.close();
    await gatewayLogger.close();
  });
  await app.register(agentRoutes(agentService, new AgentStatusService(agentResolver, subagentOrchestrator)));
  await app.register(subagentRoutes(subagentOrchestrator));
  const reloadMcpRuntimes = async (): Promise<void> => {
    const primary = agentResolver.reload(BUILTIN_AGENT_IDS.primary);
    await agentService.replaceRuntime(primary.current);
    await primary.previous?.dispose();
    const background = agentResolver.reload(BUILTIN_AGENT_IDS.transcriptionSummary);
    await transcriptionSummaryService.replaceRuntime(background.current);
    await background.previous?.dispose();
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
  await app.register(contextRoomRoutes(
    contextRoomService,
    roomDuplicateService,
    subagentConfig.enabled ? contextRoomAgentDispatcher : undefined,
    roomOverviewService,
  ));
  await app.register(documentMcpRoutes(documentMcpHost));
  await app.register(notificationMcpRoutes(notificationMcpHost));
  await app.register(documentRoutes(documentService));
  await app.register(documentOperationRoutes(
    documentOperationService,
    documentMcpHost.capabilities,
    (context) => {
      // dispatch 子 Agent（context-room 划词改写）溯源：按 completed Invocation 校验。
      if (context.invocationId) {
        if (!isSelectionRewriteInvocationAuthorized(
          subagentOrchestrator.getInvocation(context.invocationId),
          { capabilityId: context.capabilityId, roomId: context.roomId },
        )) {
          throw new Error("agent_operation_context_invalid");
        }
        return;
      }
      agentService.validateDocumentOperationContext(context);
    },
  ));
  await app.register(externalDocumentProjectionRoutes(
    externalDocumentProjectionService,
    (context) => agentService.validateDocumentOperationContext(context),
  ));
  await app.register(asrRoutes(asrService));
  await app.register(memoryRoutes(memoryService));
  await app.register(dataMigrationRoutes(dataMigrationService));
  await app.register(filesRoutes(filesService, {
    // 删除级联（§8.2）：Room/wiki 走 knowledge cleanup job，记忆按 caller_ref 删文档
    requestKnowledgeCleanup: (fileId) => {
      if (config.knowledge?.roomWikisEnabled) knowledgeService.requestFileCleanup(fileId);
    },
    deleteMemoryDocuments: (fileId) => memoryService.deleteDocumentsByCallerRef(fileId),
  }, fileClusteringService));
  await app.register(clipperRoutes(clipperService));
  await app.register(documentUnderstandingRoutes(documentUnderstandingService));
  // 统一理解引擎（U1）：接入面唯一，台账 + 三链路扇出（§7）。
  // 策略两层文件启动时整表读入：①工程默认 ingest-policy-defaults.json（包根，工程师改）
  // ②部署覆盖 ingest-policies.json（dataDir，运行环境改）。缺文件/坏条目告警降级，不阻塞启动。
  const policyWarn = (message: string) => app.log.warn({ module: "ingest.policy" }, message);
  // agent 过滤器（ingest 第一级闸门）：偏好化改造（ingest-filter-agent-plan）——
  // ① 规则文档（用户偏好段 + 系统洞察段）注入 prompt；② toolsEnabled 时换用
  // 过滤器专用 runtime（只读 memory/wiki 工具 + 全局 wiki 作用域），关闭时退回
  // 零工具 background runtime（现行为）；③ 降级链 agent → knowledge LLM → fail-open。
  const filterRulesStore = new FilterRulesStore({
    filePath: config.ingestFilter.rulesFile,
    maxBytes: config.ingestFilter.rulesMaxBytes,
  }, app.log);
  // boot 与 runtime config onChange 共用的构造器（回填给上方 onChange 闭包）。
  buildIngestFilterRuntime = () => (config.ingestFilter.toolsEnabled
    ? createIngestFilterAgentRuntime(
        config,
        // 全局 wiki 作用域（§4.2 方案 A）：过滤是全局闸门，一批可横跨多 Room，
        // 忽略 roomId 返回全部活跃 wiki（Room wikis + 配置默认集）。解析失败由
        // pi runtime 回退配置默认集。
        knowledgeService.enabled
          ? async () => {
              const ids = knowledgeService.listRoomWikis()
                .filter((wiki) => wiki.status === "active")
                .map((wiki) => wiki.knowledgeId);
              return [...new Set(ids)];
            }
          : undefined,
      )
    : backgroundAgentRuntime);
  const ingestFilterRuntime = buildIngestFilterRuntime();
  const ingestFilterService = config.ingestFilter.enabled
    ? new IngestFilterService(
      ingestFilterRuntime ?? backgroundAgentRuntime,
      agentResolver.has(BUILTIN_AGENT_IDS.knowledge) ? agentResolver : null,
        config.ingestFilter,
        app.log,
        filterRulesStore,
    )
    : null;
  // 系统洞察维护 job（§4.4）：每小时洞察 agent 蒸馏记忆 L2/L3 + wiki + 误杀样本
  // 重写 insight 段。素材域不含 L1（原子记忆琐碎噪音大）；agent 不可用或失败
  // 保留旧洞察——洞察是增强，不是依赖，无 LLM 降级路径。
  let filterInsightJob: FilterInsightJob | null = null;
  if (ingestFilterService) {
    filterInsightJob = new FilterInsightJob(
      db,
      ingestFilterRuntime,
      filterRulesStore,
      { enabled: config.ingestFilter.insightEnabled, intervalMs: config.ingestFilter.insightIntervalMs },
      app.log,
    );
    filterInsightJob.start();
    app.log.info(
      {
        mode: config.ingestFilter.mode,
        threshold: config.ingestFilter.confidenceThreshold,
        exempt: config.ingestFilter.exemptSourceKinds,
        tools: config.ingestFilter.toolsEnabled,
        insight: config.ingestFilter.insightEnabled,
      },
      "ingest filter gate enabled",
    );
  }
  const ingestService = new IngestService(
    db,
    filesService,
    knowledgeService,
    memoryService,
    app.log,
    {
      project: await loadProjectDefaults(policyWarn),
      deploy: await loadPolicyOverrides(config.dataDir, policyWarn),
    },
    ingestFilterService,
  );
  // 启动恢复：进程被杀时 pending 滞留的过滤事件重新入队（幂等）
  ingestService.recoverPendingFilters();
  filesService.setVersionIngestor(async (input) => {
    await documentUnderstandingService.parseVersion(input.fileEntryId, input.fileVersionId);
    const versionContext = filesService.getVersionContext(input.fileEntryId, input.fileVersionId);
    return ingestService.ingest({
      source: { ref: {
        sourceKind: "file",
        sourceId: input.fileEntryId,
        sourceVersionId: input.fileVersionId,
      } },
      // knowledge router 未开启时降级为仅记忆链路（引擎约束：room 依赖
      // router），与连接器 sink 同款策略；桌面 packaged 环境不注入
      // NXCORE_KNOWLEDGE_ROUTER_ENABLED，不降级会把每个文件导入整单
      // router_disabled 拒绝。显式 pipelines（如测试/内部调用）原样透传。
      ...(input.pipelines
        ? { pipelines: input.pipelines }
        : config.knowledge?.routerEnabled
          ? {}
          : { pipelines: { room: false, wiki: false, memory: true } }),
      ...(input.roomId ? { roomId: input.roomId } : {}),
      ...(versionContext?.entry.sourceKind === "web-clipper" ? { originChannel: "web-clipper" as const } : {}),
    });
  });
  realityService.setReadySink(async (event) => {
    diaryService.markStaleAt(new Date(event.startedAt));
    const roomEnabled = knowledgeService.routerEnabled;
    const memoryEnabled = memoryService.enabled;
    if (!roomEnabled && !memoryEnabled) return;
    await ingestService.ingest({
      source: { ref: { sourceKind: "reality-event", sourceId: event.id } },
      dataType: "meeting-minutes",
      occurredAt: event.endedAt ?? event.startedAt,
      pipelines: { room: roomEnabled, wiki: roomEnabled, memory: memoryEnabled },
      originChannel: "reality",
    });
  });
  perceptionService.setReadySink(async (evidence) => {
    const roomEnabled = knowledgeService.routerEnabled;
    const memoryEnabled = memoryService.enabled;
    if (!roomEnabled && !memoryEnabled) return;
    await ingestService.ingestVisualEvent({
      ...evidence,
      pipelines: { room: roomEnabled, wiki: roomEnabled, memory: memoryEnabled },
    });
  });
  perceptionService.initialize();
  // 连接器同步到的文档/邮件/日程接入统一 ingest 引擎（台账幂等 + 记忆/Room/wiki 三链路扇出）。
  // knowledge router 未开启时降级为仅记忆链路（引擎约束：room 依赖 router）。
  // 日历事件走独立 sourceKind "calendar-event"（与 CLI 引用路径同词表），
  // 否则 room 路由投影里的来源标签/关联记忆都会把它当邮件。
  nangoConnectorManager.setMemorySink((input) =>
    ingestService.ingestConnector({
      kind: input.kind === "document" ? "cloud-doc" : input.kind === "calendar" ? "calendar-event" : "mail",
      // M4 身份规范化：mail/calendar 的 sourceId = 域行 id（读侧直查域表）；
      // document 无域行，保持 connector ref。
      sourceId: input.domainRowId ?? `connector:${input.provider}:${input.connectionId}:${input.kind === "document" ? "" : `${input.kind}:`}${input.documentId}`,
      dataType: input.kind,
      title: input.title,
      markdown: input.markdown,
      // 连接级 sourceTag 进 ②b 规则信号：规则可把整个连接（如学校日历）确定性归到 Room。
      // 日历同步额外带 calendarId（scope 的 providerScopeId）：同一条连接里可只归因某个日历。
      entrySignals: {
        sourceTag: `connector:${input.provider}:${input.connectionId}`,
        ...(input.calendarId ? { calendarId: input.calendarId } : {}),
      },
      ...(config.knowledge?.routerEnabled ? {} : { pipelines: { room: false, wiki: false, memory: true } }),
    }).then(() => undefined));
  documentOutboxWorker = new DocumentOutboxWorker(
    db,
    ingestService,
    knowledgeService,
    memoryService,
    app.log,
    {
      debounceMs: knowledgeService.enabled ? config.knowledge?.ingestDebounceMs ?? 600_000 : 0,
    },
  );
  documentOutboxWorker.start();
  documentHistoryBackfillWorker = new DocumentHistoryBackfillWorker(
    db,
    documentService,
    app.log,
  );
  documentHistoryBackfillWorker.start();
  cliConnectorMarkdownService = new ConnectorMarkdownService(
    db,
    config.dataDir,
    ingestService,
    app.log,
  );
  await cliConnectorMarkdownService.initialize();
  await app.register(ingestRoutes(
    ingestService,
    filterRulesStore,
    filterInsightJob ? () => filterInsightJob!.refreshNow() : null,
  ));
  await app.register(processingRoutes(transcriptionSummaryService));
  await app.register(realityRoutes(realityService));
  await app.register(perceptionRoutes(perceptionService));
  await app.register(diaryRoutes(diaryService));
  await app.register(agentSchedulerRoutes(agentSchedulerService));
  await app.register(agentSchedulerMcpRoutes(agentSchedulerService));
  await app.register(nangoConnectorRoutes(nangoConnectorManager, nangoConnectorConfig.enabled, nangoConnectorAuthorization));

  // 阶段三 M3b：REST 前缀泛化——/v1/connectors/* 为主入口。Fastify v5 路由先于
  // onRequest（改写 URL 无效），别名经 404 兜底内部转发（app.inject 不走网络，
  // 鉴权/解析全生命周期照常）；旧前缀由插件作用域钩子打弃用头。
  // /v1/connectors/connections 是独立的通用连接入口，不参与转发。
  app.setNotFoundHandler(async (request, reply) => {
    if (
      request.url.startsWith("/v1/connectors/") &&
      request.url !== "/v1/connectors/connections" &&
      !request.url.startsWith("/v1/connectors/connections/")
    ) {
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
  if (config.knowledge) await app.register(knowledgeRoutes(knowledgeService));
  await app.register(cliConnectorRoutes(cliConnectorSyncService, ingestService, cliConnectorMarkdownService));
  await app.register(connectorSyncRoutes(cliConnectorSyncService));

  return app;
}
