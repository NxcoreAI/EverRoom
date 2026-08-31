import Fastify, { type FastifyBaseLogger } from "fastify";
import type { FastifyError } from "fastify";
import websocket from "@fastify/websocket";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { GatewayConfig } from "../config.js";
import { createDatabase } from "../infrastructure/database/client.js";
import { AgentEventBroker } from "../modules/agent/event-broker.js";
import { agentRoutes } from "../modules/agent/routes.js";
import { createAgentResolver, registerCursorCompletionAgent } from "../modules/agent/runtime-factory.js";
import { BUILTIN_AGENT_IDS } from "../modules/agent/resolver.js";
import { AgentService } from "../modules/agent/service.js";
import { auth } from "./auth.js";
import { createGatewayLogger } from "./logger.js";
import { systemRoutes } from "../modules/system/routes.js";
import "./types.js";

/** 补全会话的孤儿 TTL：编辑器侧正常路径会删除会话，超龄即崩溃残留。 */
const ORPHAN_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

/** 本服务是补全专用（DB 里只有补全会话），启动时清掉超龄孤儿会话与事件。 */
async function purgeOrphanCompletionSessions(service: AgentService, log: FastifyBaseLogger): Promise<void> {
  const deadline = Date.now() - ORPHAN_SESSION_TTL_MS;
  for (const session of service.listSessions()) {
    const updatedAt = Date.parse(session.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt > deadline) continue;
    try {
      await service.deleteSession(session.id);
    } catch (error) {
      log.warn({ err: error, sessionId: session.id }, "failed to purge orphan completion session");
    }
  }
}

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

  const agentResolver = createAgentResolver(config);
  registerCursorCompletionAgent(agentResolver, config);
  const runtime = agentResolver.resolve(BUILTIN_AGENT_IDS.cursorCompletion);
  app.log.info(
    {
      runtimeId: runtime.id,
      ...(config.cursorCompletionPi
        ? {
            provider: config.cursorCompletionPi.provider,
            model: config.cursorCompletionPi.model,
            baseUrl: config.cursorCompletionPi.baseUrl,
            api: config.cursorCompletionPi.api,
          }
        : {}),
    },
    "cursor completion runtime configured",
  );
  const agentService = new AgentService(
    db,
    runtime,
    new AgentEventBroker(),
    app.log,
    undefined,
    undefined,
    undefined,
    "direct",
    false,
  );
  await agentService.initialize();
  await purgeOrphanCompletionSessions(agentService, app.log);

  app.addHook("onClose", async () => {
    await agentService.dispose();
    await agentResolver.dispose();
    sqlite.close();
    await gatewayLogger.close();
  });
  await app.register(agentRoutes(agentService));

  return app;
}
