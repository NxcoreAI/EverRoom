import type { FastifyPluginAsync } from "fastify";
import type { ConnectorAuthorizationAttempt, ConnectorProvider } from "@nxcore/connector-contract";
import { defaultQueryProfiles } from "./query/index.js";
import { providerOfService, type ConnectorConnectionCatalog } from "./connection-runtime.js";

/** Seam4 授权缝：start/status 同契约（本地 oo 代发起）。 */
export interface AuthorizationLike {
  start(provider: ConnectorProvider): Promise<ConnectorAuthorizationAttempt & { authorizationUrl: string }>;
  status(id: string): Promise<ConnectorAuthorizationAttempt | null>;
}

/**
 * 连接器 REST 面（P4 之后的一版）：
 *   - status / connections / providers：实时读 oo（本地只叠加墓碑）
 *   - authorizations：本地模式由 Gateway 代发起
 *   - DELETE connection：写本地墓碑
 *   - 同步时代的 endpoints 全部 410
 */
export const connectorRoutes =
  (
    catalog: ConnectorConnectionCatalog,
    authorization?: AuthorizationLike,
    enabled = true,
  ): FastifyPluginAsync =>
  async (app) => {
    app.addHook("onRequest", async (request, reply) => {
      if (request.headers["x-internal-alias"] === "1") return;
      if (request.url.startsWith("/v1/nango-connectors/")) {
        reply.header("Deprecation", "true");
        reply.header("Warning", '299 - "prefix /v1/nango-connectors is deprecated; use /v1/connectors"');
      }
    });

    const unavailable = (reply: any) =>
      reply.code(503).send({ error: "connectors_disabled", message: "Connector module is disabled" });

    app.get("/v1/nango-connectors/status", async () => ({
      enabled,
      connections: await catalog.list(),
      // 断开的连接（本地墓碑）：oo 凭据仍在，客户端据此区分「未开启」和「未连接」。
      disconnected: catalog.listDisconnected(),
      // 同步链路已删除：保留字段一个版本，桌面旧版本读到空数组即可。
      scopes: [],
      runs: [],
    }));

    app.get("/v1/nango-connectors/providers", async () => {
      const connections = await catalog.list();
      const connected = new Set(connections.map((connection) => connection.provider));
      return {
        enabled,
        providers: defaultQueryProfiles.map((profile) => {
          const provider = providerOfService(profile.service);
          return {
            provider,
            label: profile.service,
            category: profile.dataTypes.includes("mail")
              ? "mail"
              : profile.dataTypes.includes("event")
                ? "calendar"
                : "docs",
            iconKey: profile.service,
            dataTypes: profile.dataTypes.map((kind) => (kind === "document" ? "document" : kind)),
            authChannel: "nango-oauth",
            connected: connected.has(provider),
            comingSoon: false,
          };
        }),
      };
    });

    app.get("/v1/nango-connectors/connections", async () => catalog.list());

    app.post("/v1/nango-connectors/authorizations", async (req, reply) => {
      if (!enabled || !authorization) return unavailable(reply);
      const provider = (req.body as any)?.provider;
      if (typeof provider !== "string" || !provider.trim()) {
        return reply.code(400).send({ error: "invalid_provider" });
      }
      try {
        return reply.code(201).send(await authorization.start(provider));
      } catch (error) {
        return reply.code(502).send({
          error: "authorization_start_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    app.get("/v1/nango-connectors/authorizations/:id", async (req, reply) => {
      if (!enabled || !authorization) return unavailable(reply);
      try {
        const attempt = await authorization.status((req.params as any).id);
        return attempt ?? reply.code(404).send({ error: "authorization_not_found" });
      } catch (error) {
        return reply.code(502).send({
          error: "authorization_status_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // 断开：本地墓碑；oo 远端凭据保留。查询/execute_action 会按墓碑过滤。
    app.delete("/v1/nango-connectors/connections/:id", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      const removed = catalog.disconnect((req.params as any).id);
      if (!removed) return reply.code(400).send({ error: "invalid_connection_id" });
      return { ok: true };
    });

    // 重新开启：移除本地墓碑（oo 凭据一直在），连接回到可见/可查询状态。
    app.post("/v1/nango-connectors/connections/:id/reconnect", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      const reconnected = catalog.reconnect((req.params as any).id);
      if (!reconnected) return reply.code(400).send({ error: "invalid_connection_id" });
      return { ok: true };
    });

    // 同步时代端点：保留一个版本的 410，便于旧桌面版本给出可读错误。
    const gone = async (_req: unknown, reply: any) =>
      reply.code(410).send({
        error: "sync_removed",
        message: "连接器已改为 Agent 即席查询，同步/记录/文档接口已移除。请升级桌面端。",
      });
    for (const path of [
      "/v1/nango-connectors/scopes",
      "/v1/nango-connectors/runs",
      "/v1/nango-connectors/failures",
    ]) {
      app.get(path, gone);
    }
    for (const path of [
      "/v1/nango-connectors/scopes/:id/sync",
      "/v1/nango-connectors/runs/:id/cancel",
      "/v1/nango-connectors/connections/:id/disable",
      "/v1/nango-connectors/connections/:id/enable",
      "/v1/nango-connectors/debug/faults",
    ]) {
      app.post(path, gone);
    }
    for (const path of [
      "/v1/nango-connectors/connections/:id/messages",
      "/v1/nango-connectors/connections/:id/documents",
      "/v1/nango-connectors/connections/:id/documents/:documentId",
      "/v1/nango-connectors/connections/:id/records",
    ]) {
      app.get(path, gone);
    }
  };
