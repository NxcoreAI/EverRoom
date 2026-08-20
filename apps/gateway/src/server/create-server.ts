import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
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
import { mcpRoutes } from "../modules/agent/mcp-routes.js";
import { AgentService } from "../modules/agent/service.js";
import { DocumentEventBroker } from "../modules/documents/event-broker.js";
import { DocumentMcpHost } from "../modules/documents/mcp-host.js";
import { DocumentOperationService } from "../modules/documents/operations/service.js";
import { documentMcpRoutes } from "../modules/documents/mcp-routes.js";
import { documentRoutes } from "../modules/documents/routes.js";
import { documentOperationRoutes } from "../modules/documents/operations/routes.js";
import { DocumentService } from "../modules/documents/service.js";
import {
  createAgentResolver,
  registerConnectorSyncAgent,
  registerPrimaryAgent,
  registerTranscriptionSummaryAgent,
} from "../modules/agent/runtime-factory.js";
import { BUILTIN_AGENT_IDS } from "../modules/agent/resolver.js";
import { DocumentServiceError } from "../modules/documents/errors.js";
import { contextRoomRoutes } from "../modules/context-rooms/routes.js";
import { ContextRoomService } from "../modules/context-rooms/service.js";
import { AsrError } from "../modules/asr/errors.js";
import { createAsrProvider } from "../modules/asr/provider-factory.js";
import { asrRoutes } from "../modules/asr/routes.js";
import { AsrService } from "../modules/asr/service.js";
import type { AsrProvider } from "../modules/asr/types.js";
import { MemoryGatewayError } from "../modules/memory/errors.js";
import { memoryRoutes } from "../modules/memory/routes.js";
import { MemoryService } from "../modules/memory/service.js";
import { filesRoutes } from "../modules/files/routes.js";
import { FilesService } from "../modules/files/service.js";
import { ingestRoutes } from "../modules/ingest/routes.js";
import { IngestService } from "../modules/ingest/service.js";
import { DocumentOutboxWorker } from "../modules/ingest/document-outbox-worker.js";
import { loadPolicyOverrides, loadProjectDefaults } from "../modules/ingest/policy.js";
import { knowledgeRoutes } from "../modules/knowledge/routes.js";
import { KnowledgeService } from "../modules/knowledge/service.js";
import { cliConnectorRoutes, nangoConnectorRoutes } from "../modules/connectors/routes.js";
import { ConnectorMarkdownService } from "../modules/connectors/markdown-service.js";
import { ConnectorSyncService } from "../modules/connectors/service.js";
import { processingRoutes } from "../modules/processing/routes.js";
import { TranscriptionSummaryService } from "../modules/processing/service.js";
import { RealityError } from "../modules/reality/errors.js";
import { realityRoutes } from "../modules/reality/routes.js";
import { RealityService } from "../modules/reality/service.js";
import { auth } from "./auth.js";
import { createGatewayLogger } from "./logger.js";
import "./types.js";
import { createConnectorDatabase } from "../infrastructure/connectors/client.js";
import { ConnectorRepository } from "../modules/connectors/repository.js";
import { ConnectorManager } from "../modules/connectors/manager.js";
import { NangoExecutor } from "../modules/connectors/nango-executor.js";
import { NangoAuthorizationService } from "../modules/connectors/nango-authorization.js";
import { bootstrapNango } from "../modules/connectors/nango-bootstrap.js";
import { ConnectorDocumentStore } from "../modules/connectors/document-store.js";
import { SubagentRegistry } from "../modules/subagents/registry.js";
import { SubagentRuntimeManager } from "../modules/subagents/runtime-manager.js";
import { SubagentOrchestrator } from "../modules/subagents/orchestrator.js";
import { createSubagentPiTools } from "../modules/subagents/tools.js";
import { subagentRoutes } from "../modules/subagents/routes.js";

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
  const app = Fastify({
    loggerInstance: gatewayLogger.logger,
    routerOptions: {
      // knowledge 文件路由的 id 可能是 caller_ref（如 connector:provider:<uuid>:<docId>），
      // URL 编码后超 Fastify 默认 100 上限被拒。500 覆盖最长组合。
      maxParamLength: 500,
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const { db, sqlite } = createDatabase(config.databasePath, config.migrationsDir);
  app.decorate("db", db);
  const nangoConnectorConfig = config.nangoConnector ?? { enabled:false, databasePath:resolve(config.dataDir,"database","connectors.sqlite"), nangoUrl:"", nangoSecret:"", gmailConfigKey:"", outlookConfigKey:"", googleDocsConfigKey:"", notionConfigKey:"", googleCalendarConfigKey:"", googleClientId:"", googleClientSecret:"", notionClientId:"", notionClientSecret:"", outlookClientId:"", outlookClientSecret:"", pollingIntervalMs:300_000 };
  // 启动时自举 Nango:必要时创建 API key、按 .env 凭据补建 Google/Notion integration。
  const nangoSecret = nangoConnectorConfig.enabled ? await bootstrapNango(nangoConnectorConfig) : nangoConnectorConfig.nangoSecret;
  const nangoConnectorDb = createConnectorDatabase(nangoConnectorConfig.enabled ? nangoConnectorConfig.databasePath : ":memory:");
  const nangoConnectorManager = new ConnectorManager(
    new ConnectorRepository(nangoConnectorDb.sqlite),
    nangoConnectorConfig.enabled ? new NangoExecutor(nangoConnectorConfig.nangoUrl, nangoSecret) : null,
    nangoConnectorConfig.enabled ? new ConnectorDocumentStore(resolve(config.dataDir, "connectors", "documents")) : null,
  );
  const nangoConnectorAuthorization = nangoConnectorConfig.enabled && "gmailConfigKey" in nangoConnectorConfig
    ? new NangoAuthorizationService(
        nangoConnectorConfig.nangoUrl,
        nangoSecret,
        {
          gmail: nangoConnectorConfig.gmailConfigKey,
          outlook: nangoConnectorConfig.outlookConfigKey,
          "google-docs": nangoConnectorConfig.googleDocsConfigKey,
          notion: nangoConnectorConfig.notionConfigKey,
          "google-calendar": nangoConnectorConfig.googleCalendarConfigKey,
        },
        nangoConnectorManager,
      )
    : undefined;
  if (nangoConnectorConfig.enabled) nangoConnectorManager.startPolling("pollingIntervalMs" in nangoConnectorConfig ? nangoConnectorConfig.pollingIntervalMs : 300_000);

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "request failed");
    if (error instanceof AsrError) {
      await reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        requestId: request.id,
      });
      return;
    }
    if (error instanceof MemoryGatewayError || error instanceof RealityError) {
      await reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        requestId: request.id,
      });
      return;
    }
    if (error instanceof DocumentServiceError) {
      await reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...error.details,
        requestId: request.id,
      });
      return;
    }
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    await reply.code(statusCode).send({
      error: statusCode === 500 ? "internal_error" : "request_error",
      message: statusCode === 500 ? "An internal gateway error occurred" : error.message,
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
  const memoryService = new MemoryService(config.pi?.memory ?? null, app.log, { db, dataDir: config.dataDir });
  const contextRoomService = new ContextRoomService(db);
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
      entityPromoteScore: config.knowledge?.entityPromoteScore ?? 2.0,
      entityPromoteSources: config.knowledge?.entityPromoteSources ?? 2,
      mergeAutoDice: config.knowledge?.mergeAutoDice ?? 0.75,
      mergeJudgeDice: config.knowledge?.mergeJudgeDice ?? 0.6,
      llm: config.knowledge?.llm ?? null,
      embeddingLlm: config.knowledge?.embeddingLlm ?? null,
      embeddingModel: config.knowledge?.embeddingModel ?? "",
    },
    app.log,
    agentResolver,
  );
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
  const subagentRuntimeManager = new SubagentRuntimeManager(config, subagentConfig);
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
  const recoveredSubagentInvocations = subagentOrchestrator.initialize();
  if (recoveredSubagentInvocations > 0) {
    app.log.info({ recoveredSubagentInvocations }, "subagent invocations interrupted after restart");
  }
  registerPrimaryAgent(agentResolver, config, documentMcpHost, {
    ...(subagentConfig.enabled
      ? { tools: createSubagentPiTools(subagentRegistry, subagentOrchestrator) }
      : {}),
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
  }, cliConnectorSyncService);
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
  const asrProvider = Object.hasOwn(overrides, "asrProvider")
    ? overrides.asrProvider ?? null
    : createAsrProvider(config, app.log);
  const asrService = new AsrService(db, config.asrInputDir, asrProvider, app.log);
  // 文件管理中心（U9 唯一字节入口）：对象库 + uploaded/parsed 登记；
  // 删除级联经钩子回调 knowledge（wiki 清理）与 memory（文档删除）。
  const filesService = new FilesService(db, config.dataDir);
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
  app.addHook("onClose", async () => {
    await nangoConnectorManager.dispose();
    nangoConnectorDb.close();
    clearInterval(documentOperationExpiryTimer);
    await agentService.dispose();
    await subagentOrchestrator.dispose();
    await transcriptionSummaryService.dispose();
    await documentMcpHost.close();
    await documentOutboxWorker?.dispose();
    await cliConnectorSyncService.dispose();
    await cliConnectorMarkdownService?.dispose();
    knowledgeService.dispose();
    await asrService.dispose();
    await agentResolver.dispose();
    sqlite.close();
    await gatewayLogger.close();
  });
  await app.register(agentRoutes(agentService));
  await app.register(subagentRoutes(subagentOrchestrator));
  await app.register(mcpRoutes(config));
  await app.register(contextRoomRoutes(contextRoomService));
  await app.register(documentMcpRoutes(documentMcpHost));
  await app.register(documentRoutes(documentService));
  await app.register(documentOperationRoutes(
    documentOperationService,
    documentMcpHost.capabilities,
    (context) => agentService.validateDocumentOperationContext(context),
  ));
  await app.register(asrRoutes(asrService));
  await app.register(memoryRoutes(memoryService));
  await app.register(filesRoutes(filesService, {
    // 删除级联（§8.2）：Room/wiki 走 knowledge cleanup job，记忆按 caller_ref 删文档
    requestKnowledgeCleanup: (fileId) => {
      if (config.knowledge?.roomWikisEnabled) knowledgeService.requestFileCleanup(fileId);
    },
    deleteMemoryDocuments: (fileId) => memoryService.deleteDocumentsByCallerRef(fileId),
  }));
  // 统一理解引擎（U1）：接入面唯一，台账 + 三链路扇出（§7）。
  // 策略两层文件启动时整表读入：①工程默认 ingest-policy-defaults.json（包根，工程师改）
  // ②部署覆盖 ingest-policies.json（dataDir，运行环境改）。缺文件/坏条目告警降级，不阻塞启动。
  const policyWarn = (message: string) => app.log.warn({ module: "ingest.policy" }, message);
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
  );
  // 连接器同步到的文档/邮件/日程接入统一 ingest 引擎（台账幂等 + 记忆/Room/wiki 三链路扇出）。
  // knowledge router 未开启时降级为仅记忆链路（引擎约束：room 依赖 router）。
  nangoConnectorManager.setMemorySink((input) =>
    ingestService.ingestConnector({
      kind: input.kind === "document" ? "cloud-doc" : "mail",
      sourceId: `connector:${input.provider}:${input.connectionId}:${input.kind === "document" ? "" : `${input.kind}:`}${input.documentId}`,
      dataType: input.kind,
      title: input.title,
      markdown: input.markdown,
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
  cliConnectorMarkdownService = new ConnectorMarkdownService(
    db,
    config.dataDir,
    ingestService,
    app.log,
  );
  await cliConnectorMarkdownService.initialize();
  // 智能感知在用户确认完成后自动进入统一理解引擎：
  // reality-event → Markdown → Room 路由 → Wiki（策略与文件链路共用）。
  if (config.knowledge?.roomWikisEnabled && config.knowledge.routerEnabled) {
    realityService.setKnowledgeIngestHandler(({ sourceId }) => ingestService.ingest({
      source: { ref: { sourceKind: "reality-event", sourceId } },
      dataType: "meeting-minutes",
      originChannel: "reality",
    }));
  }
  await app.register(ingestRoutes(ingestService));
  await app.register(processingRoutes(transcriptionSummaryService));
  await app.register(realityRoutes(realityService));
  await app.register(nangoConnectorRoutes(nangoConnectorManager, nangoConnectorConfig.enabled, nangoConnectorAuthorization));
  if (config.knowledge) await app.register(knowledgeRoutes(knowledgeService));
  await app.register(cliConnectorRoutes(cliConnectorSyncService, ingestService, cliConnectorMarkdownService));

  return app;
}
