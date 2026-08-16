import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyError } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { GatewayConfig } from "../config.js";
import { createDatabase } from "../infrastructure/database/client.js";
import { systemRoutes } from "../modules/system/routes.js";
import { AgentEventBroker } from "../modules/agent/event-broker.js";
import { agentRoutes } from "../modules/agent/routes.js";
import { AgentService } from "../modules/agent/service.js";
import { DocumentEventBroker } from "../modules/documents/event-broker.js";
import { DocumentMcpHost } from "../modules/documents/mcp-host.js";
import { documentMcpRoutes } from "../modules/documents/mcp-routes.js";
import { documentRoutes } from "../modules/documents/routes.js";
import { DocumentService } from "../modules/documents/service.js";
import { createAgentRuntime } from "../modules/agent/runtime-factory.js";
import { AsrError } from "../modules/asr/errors.js";
import { createAsrProvider } from "../modules/asr/provider-factory.js";
import { asrRoutes } from "../modules/asr/routes.js";
import { AsrService } from "../modules/asr/service.js";
import type { AsrProvider } from "../modules/asr/types.js";
import { RealityError } from "../modules/reality/errors.js";
import { realityRoutes } from "../modules/reality/routes.js";
import { RealityService } from "../modules/reality/service.js";
import { auth } from "./auth.js";
import { createGatewayLogger } from "./logger.js";
import "./types.js";
import { createConnectorDatabase } from "../infrastructure/connectors/client.js";
import { ConnectorRepository } from "../modules/connectors/repository.js";
import { ConnectorManager } from "../modules/connectors/manager.js";
import { connectorRoutes } from "../modules/connectors/routes.js";
import { NangoExecutor } from "../modules/connectors/nango-executor.js";
import { NangoAuthorizationService } from "../modules/connectors/nango-authorization.js";

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
  }).withTypeProvider<TypeBoxTypeProvider>();

  const { db, sqlite } = createDatabase(config.databasePath, config.migrationsDir);
  app.decorate("db", db);
  const connectorConfig = config.connectors ?? { enabled:false, databasePath:resolve(config.dataDir,"database","connectors.sqlite"), nangoUrl:"", nangoSecret:"" };
  const connectorDb = createConnectorDatabase(connectorConfig.enabled ? connectorConfig.databasePath : ":memory:");
  const connectorManager = new ConnectorManager(new ConnectorRepository(connectorDb.sqlite), connectorConfig.enabled ? new NangoExecutor(connectorConfig.nangoUrl, connectorConfig.nangoSecret) : null);
  const connectorAuthorization = connectorConfig.enabled && "gmailConfigKey" in connectorConfig
    ? new NangoAuthorizationService(
        connectorConfig.nangoUrl,
        connectorConfig.nangoSecret,
        {
          gmail: connectorConfig.gmailConfigKey,
          outlook: connectorConfig.outlookConfigKey,
        },
        connectorManager,
      )
    : undefined;
  if (connectorConfig.enabled) connectorManager.startPolling("pollingIntervalMs" in connectorConfig ? connectorConfig.pollingIntervalMs : 300_000);

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
    if (error instanceof RealityError) {
      await reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
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
  const documentService = new DocumentService(db, new DocumentEventBroker());
  const documentMcpHost = new DocumentMcpHost(documentService);
  const agentRuntime = createAgentRuntime(config, documentMcpHost);
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
  const agentService = new AgentService(db, agentRuntime, new AgentEventBroker(), app.log);
  await agentService.initialize();
  const asrProvider = Object.hasOwn(overrides, "asrProvider")
    ? overrides.asrProvider ?? null
    : createAsrProvider(config, app.log);
  const asrService = new AsrService(db, config.asrInputDir, asrProvider, app.log);
  const realityService = new RealityService(db, config.asrInputDir, app.log);
  const recoveredCaptures = realityService.recoverInterruptedCaptures();
  if (recoveredCaptures > 0) {
    app.log.info({ recoveredCaptures }, "interrupted reality captures recovered");
  }
  app.addHook("onClose", async () => {
    await connectorManager.dispose();
    connectorDb.close();
    await agentService.dispose();
    await documentMcpHost.close();
    documentService.dispose();
    await asrService.dispose();
    sqlite.close();
    await gatewayLogger.close();
  });
  await app.register(agentRoutes(agentService));
  await app.register(documentMcpRoutes(documentMcpHost));
  await app.register(documentRoutes(documentService));
  await app.register(asrRoutes(asrService));
  await app.register(realityRoutes(realityService));
  await app.register(connectorRoutes(connectorManager, connectorConfig.enabled, connectorAuthorization));

  return app;
}
