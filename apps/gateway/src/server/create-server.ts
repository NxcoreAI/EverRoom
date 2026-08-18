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
import { createAgentRuntime, createBackgroundAgentRuntime } from "../modules/agent/runtime-factory.js";
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
import { processingRoutes } from "../modules/processing/routes.js";
import { TranscriptionSummaryService } from "../modules/processing/service.js";
import { RealityError } from "../modules/reality/errors.js";
import { realityRoutes } from "../modules/reality/routes.js";
import { RealityService } from "../modules/reality/service.js";
import { auth } from "./auth.js";
import { createGatewayLogger } from "./logger.js";
import "./types.js";

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
  const memoryService = new MemoryService(config.memory, app.log);
  const contextRoomService = new ContextRoomService(db);
  const documentService = new DocumentService(db, new DocumentEventBroker(), (document) => {
    void memoryService.captureDocumentCreation(document).catch((error: unknown) => {
      app.log.warn({ err: error, documentId: document.documentId }, "document memory capture failed");
    });
  });
  const documentMcpHost = new DocumentMcpHost(documentService, contextRoomService);
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
  const agentService = new AgentService(
    db,
    agentRuntime,
    new AgentEventBroker(),
    app.log,
    contextRoomService,
  );
  await agentService.initialize();
  const backgroundAgentRuntime = createBackgroundAgentRuntime(config);
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
  const transcriptionSummaryService = new TranscriptionSummaryService(backgroundAgentRuntime);
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
    await agentService.dispose();
    await transcriptionSummaryService.dispose();
    await documentMcpHost.close();
    documentService.dispose();
    await asrService.dispose();
    sqlite.close();
    await gatewayLogger.close();
  });
  await app.register(agentRoutes(agentService));
  await app.register(contextRoomRoutes(contextRoomService));
  await app.register(documentMcpRoutes(documentMcpHost));
  await app.register(documentRoutes(documentService));
  await app.register(asrRoutes(asrService));
  await app.register(memoryRoutes(memoryService));
  await app.register(processingRoutes(transcriptionSummaryService));
  await app.register(realityRoutes(realityService));

  return app;
}
