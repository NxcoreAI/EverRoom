import Fastify, { type FastifyBaseLogger } from "fastify";
import type { FastifyError } from "fastify";
import websocket from "@fastify/websocket";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { bundledAgentDefinitionsDir, type GatewayConfig } from "../config.js";
import { createDatabase } from "../infrastructure/database/client.js";
import { agentSessions } from "../infrastructure/database/schema.js";
import { AgentDebugArchive } from "../modules/agent-debug/archive.js";
import { AgentDebugTraceStore } from "../modules/agent-debug/trace-store.js";
import { agentDebugTraceRoutes, debugAgentsFromResolver } from "../modules/agent-debug/routes.js";
import { AgentEventBroker } from "../modules/agent/event-broker.js";
import { agentRoutes } from "../modules/agent/routes.js";
import { createAgentResolver, registerCursorCompletionAgent } from "../modules/agent/runtime-factory.js";
import { AgentSkillStateStore } from "../modules/skills/state-store.js";
import { SkillService } from "../modules/skills/service.js";
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

  // 补全网关独立写自己的归档目录（与主网关不同 source，索引互不覆盖）。
  const agentDebugArchiveConfig = config.agentDebugArchive;
  const agentDebugArchive = agentDebugArchiveConfig?.enabled === false
    ? undefined
    : new AgentDebugArchive({
        dir: join(config.dataDir, "agent-debug", "cursor-completion"),
        ...(agentDebugArchiveConfig
          ? {
              retentionDays: agentDebugArchiveConfig.retentionDays,
              maxRuns: agentDebugArchiveConfig.maxRuns,
              maxBytes: agentDebugArchiveConfig.maxBytes,
            }
          : {}),
        warn: (message, error) => app.log.warn({ err: error }, message),
      });
  const agentDebugStore = new AgentDebugTraceStore(agentDebugArchive);
  const agentDebugSessionTitles = (
    sessionIds: readonly string[],
  ): ReadonlyMap<string, string | null> => {
    const titles = new Map<string, string | null>();
    if (sessionIds.length === 0) return titles;
    try {
      const rows = db
        .select({ id: agentSessions.id, title: agentSessions.title })
        .from(agentSessions)
        .where(inArray(agentSessions.id, [...sessionIds]))
        .all();
      for (const row of rows) titles.set(row.id, row.title ?? null);
    } catch (error) {
      app.log.warn({ err: error }, "agent debug session titles lookup failed");
    }
    return titles;
  };
  const agentResolver = createAgentResolver(config, agentDebugStore);
  registerCursorCompletionAgent(agentResolver, config);
  // 补全技能也走「技能」页的启停：本进程在启动时读一次状态（补全网关是独立进程，
  // 主网关改状态不会通知到这里，下一次启动生效）。
  const skillService = new SkillService({
    store: new AgentSkillStateStore(db),
    definitionsDir: bundledAgentDefinitionsDir(),
    logger: { warn: (fields, message) => app.log.warn(fields, message) },
  });
  registerCursorCompletionAgent(agentResolver, config, skillService);
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
    false,
  );
  await agentService.initialize();
  await purgeOrphanCompletionSessions(agentService, app.log);

  app.addHook("onClose", async () => {
    await agentService.dispose();
    await agentResolver.dispose();
    // running run 收尾为 interrupted 后等待写盘队列排空。
    await agentDebugStore.dispose();
    sqlite.close();
    await gatewayLogger.close();
  });
  await app.register(agentRoutes(agentService));
  // 补全网关没有 status service：调试页 Agent 目录从 resolver 定义 + activity 推导，
  // 本机 CLI Agent 由 store 观测结果合并。
  await app.register(agentDebugTraceRoutes(
    agentDebugStore,
    () => debugAgentsFromResolver(agentResolver),
    { sessionTitles: agentDebugSessionTitles },
  ));

  return app;
}
