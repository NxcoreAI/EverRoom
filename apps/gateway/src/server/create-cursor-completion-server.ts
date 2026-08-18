import Fastify from "fastify";
import type { FastifyError } from "fastify";
import websocket from "@fastify/websocket";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { GatewayConfig } from "../config.js";
import { createDatabase } from "../infrastructure/database/client.js";
import { AgentEventBroker } from "../modules/agent/event-broker.js";
import { agentRoutes } from "../modules/agent/routes.js";
import { createCursorCompletionRuntime } from "../modules/agent/runtime-factory.js";
import { AgentService } from "../modules/agent/service.js";
import { auth } from "./auth.js";
import { createGatewayLogger } from "./logger.js";
import { systemRoutes } from "../modules/system/routes.js";
import "./types.js";

export async function createCursorCompletionServer(config: GatewayConfig) {
  const gatewayLogger = await createGatewayLogger(config.dataDir, config.logLevel);
  const app = Fastify({
    loggerInstance: gatewayLogger.logger,
  }).withTypeProvider<TypeBoxTypeProvider>();
  const { db, sqlite } = createDatabase(config.databasePath, config.migrationsDir);
  app.decorate("db", db);

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "cursor completion request failed");
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    await reply.code(statusCode).send({
      error: statusCode === 500 ? "internal_error" : "request_error",
      message: statusCode === 500 ? "Cursor completion service failed" : error.message,
      requestId: request.id,
    });
  });

  await app.register(websocket);
  await app.register(auth, { token: config.authToken });
  await app.register(systemRoutes);

  const runtime = createCursorCompletionRuntime(config);
  app.log.info(
    {
      runtimeId: runtime.id,
      ...(config.pi
        ? {
            provider: config.pi.provider,
            model: config.pi.model,
            baseUrl: config.pi.baseUrl,
            api: config.pi.api,
          }
        : {}),
    },
    "cursor completion runtime configured",
  );
  const agentService = new AgentService(db, runtime, new AgentEventBroker(), app.log);
  await agentService.initialize();

  app.addHook("onClose", async () => {
    await agentService.dispose();
    sqlite.close();
    await gatewayLogger.close();
  });
  await app.register(agentRoutes(agentService));

  return app;
}
