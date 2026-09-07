import type { FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";
import { isConnectorProvider, isSyncMode } from "@nxcore/connector-contract";
import type { ConnectorManager } from "./manager.js";

import type { ConnectorProvider } from "@nxcore/connector-contract";
import type { ConnectorAuthorizationAttempt } from "@nxcore/connector-contract";

/** Seam4 授权缝：start/status 同契约，Nango（回退）与 OpenConnector 实现共用。 */
export interface AuthorizationLike {
  start(provider: ConnectorProvider): Promise<ConnectorAuthorizationAttempt & { authorizationUrl: string }>;
  status(id: string): Promise<ConnectorAuthorizationAttempt | null>;
}
import { normalizeWebcalUrl } from "./auth-channels/types.js";
import { SYNC_PROVIDERS, syncProviderNames, syncProviderOf } from "./sync-providers/index.js";
const pageParams = (query: any) => {
  const limit = query?.limit === undefined ? 200 : Number(query.limit);
  const offset = query?.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1 || limit > 500 || offset < 0)
    throw Object.assign(new Error("invalid_page"), { statusCode: 400 });
  const provider = query?.provider;
  if (provider !== undefined && !isConnectorProvider(provider, syncProviderNames()))
    throw Object.assign(new Error("invalid_provider"), { statusCode: 400 });
  return { limit, offset, ...(provider ? { provider } : {}) };
};
export const nangoConnectorRoutes =
  (
    manager: ConnectorManager,
    enabled: boolean,
    /** Seam4：Nango（回退）或 OpenConnector 授权服务（同 start/status 契约）。 */
    authorization?: AuthorizationLike,
  ): FastifyPluginAsync =>
  async (app) => {
    // M3b：旧前缀弃用告警（直接命中 /v1/nango-connectors/* 时打头；
    // /v1/connectors/* 别名转发带 x-internal-alias，不打）。
    app.addHook("onRequest", async (request, reply) => {
      if (request.headers["x-internal-alias"] === "1") return;
      if (request.url.startsWith("/v1/nango-connectors/")) {
        reply.header("Deprecation", "true");
        reply.header("Warning", '299 - "prefix /v1/nango-connectors is deprecated; use /v1/connectors"');
      }
    });
    const scopes = () =>
      manager.repository
        .listScopes()
        .map((scope) => ({ ...scope, sourceCursor: null }));
    const unavailable = (reply: any) =>
      reply
        .code(503)
        .send({
          error: "connectors_disabled",
          message: "Connector module is disabled",
        });
    app.get("/v1/nango-connectors/status", async () => ({
      enabled,
      connections: manager.repository.listConnections(),
      scopes: scopes(),
      runs: manager.repository.listRuns(),
    }));
    // 阶段二：注册表元数据端点——连接菜单/图标/分类的数据源（桌面端收敛的契约面）。
    app.get("/v1/nango-connectors/providers", async () => {
      const connected = new Set(
        manager.repository.listConnections().map((connection) => connection.provider),
      );
      return {
        enabled,
        providers: SYNC_PROVIDERS.map((definition) => ({
          provider: definition.provider,
          label: definition.ui.label,
          category: definition.ui.category,
          iconKey: definition.ui.iconKey,
          dataTypes: definition.dataTypes,
          authChannel: definition.auth.channel,
          connected: connected.has(definition.provider),
          comingSoon: definition.ui.comingSoon === true,
        })),
      };
    });
    app.get("/v1/nango-connectors/connections", async () =>
      manager.repository.listConnections(),
    );
    app.post("/v1/nango-connectors/authorizations", async (req, reply) => {
      if (!enabled || !authorization) return unavailable(reply);
      const provider = (req.body as any)?.provider;
      if (!isConnectorProvider(provider, syncProviderNames()))
        return reply.code(400).send({ error: "invalid_provider" });
      try {
        return reply.code(201).send(await authorization.start(provider));
      } catch (error) {
        return reply.code(502).send({
          error: "authorization_start_failed",
          message: (error instanceof Error ? error.message : String(error)),
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
          message: (error instanceof Error ? error.message : String(error)),
        });
      }
    });
    app.post("/v1/nango-connectors/connections", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      const b = req.body as any;
      if (
        !isConnectorProvider(b?.provider, syncProviderNames()) ||
        typeof b?.connectionName !== "string" ||
        typeof b?.service !== "string"
      )
        return reply.code(400).send({ error: "invalid_connection" });
      try {
        return reply.code(201).send(await manager.register(b));
      } catch {
        return reply
          .code(409)
          .send({ error: "connection_registration_failed" });
      }
    });
    // 阶段三：非 OAuth 直连源的连接入口（泛化前缀 /v1/connectors/connections）。
    // webcal-url 通道收 url；api-token 通道收 credentials（"appId:appSecret"）。
    // 同凭据重复连接幂等返回既有连接；响应不回显 credentialsRef（含令牌/密钥）。
    app.post("/v1/connectors/connections", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      const body = req.body as any;
      const definition = syncProviderOf(String(body?.provider ?? ""));
      if (!definition || definition.engine !== "direct")
        return reply.code(400).send({ error: "invalid_direct_provider" });
      let credentials: string;
      try {
        if (definition.auth.channel === "webcal-url") {
          credentials = normalizeWebcalUrl(typeof body?.url === "string" ? body.url : "").toString();
        } else if (definition.auth.channel === "api-token") {
          credentials = typeof body?.credentials === "string" ? body.credentials.trim() : "";
          const separator = credentials.indexOf(":");
          if (separator <= 0 || separator === credentials.length - 1)
            throw new Error("api_token_credentials_invalid");
        } else {
          return reply.code(400).send({ error: "unsupported_auth_channel" });
        }
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid_credentials" });
      }
      const connectionKey = `${definition.auth.channel}:${createHash("sha256").update(credentials).digest("hex").slice(0, 24)}`;
      const existing = manager.repository
        .listConnections()
        .find((connection) => connection.provider === definition.provider && connection.connectionName === connectionKey);
      if (existing) {
        const { credentialsRef: _omitted, ...safe } = existing;
        return reply.code(200).send(safe);
      }
      try {
        const connection = await manager.register({
          provider: definition.provider,
          service: "direct",
          connectionName: connectionKey,
          authMethod: definition.auth.channel,
          credentialsRef: credentials,
        });
        const { credentialsRef: _omitted, ...safe } = connection;
        return reply.code(201).send(safe);
      } catch {
        return reply.code(409).send({ error: "connection_registration_failed" });
      }
    });
    app.post("/v1/nango-connectors/connections/:id/disable", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      manager.repository.disableConnection((req.params as any).id);
      return { ok: true };
    });
    app.post("/v1/nango-connectors/connections/:id/enable", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      manager.repository.enableConnection((req.params as any).id);
      return { ok: true };
    });
    app.delete("/v1/nango-connectors/connections/:id", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      manager.repository.purgeConnection((req.params as any).id);
      return { ok: true };
    });
    app.get("/v1/nango-connectors/scopes", async () => scopes());
    app.get("/v1/nango-connectors/runs", async () => manager.repository.listRuns());
    app.post("/v1/nango-connectors/runs/:id/cancel", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      return (
        manager.cancel((req.params as any).id) ??
        reply.code(404).send({ error: "run_not_found" })
      );
    });
    app.post("/v1/nango-connectors/scopes/:id/sync", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      const mode = (req.body as any)?.mode ?? "incremental";
      if (!isSyncMode(mode))
        return reply.code(400).send({ error: "invalid_mode" });
      const scopeId = (req.params as any).id;
      const existing = manager.repository
        .listRuns()
        .find((r) => r.scopeId === scopeId && r.status === "running");
      if (existing) return reply.code(409).send({
        error: "sync_already_running",
        message: `该同步范围已有运行中的任务（${existing.id}）。`,
        run: existing,
      });
      try {
        return reply.code(202).send(manager.trigger(scopeId, mode));
      } catch (error) {
        const message = error instanceof Error ? error.message : "connection_unavailable";
        return reply.code(409).send({ error: "sync_start_failed", message });
      }
    });
    app.get("/v1/nango-connectors/connections/:id/messages", async (req, reply) => {
      try {
        const page = pageParams(req.query);
        return {
          items: manager.repository.messages((req.params as any).id, page),
          total: manager.repository.countMessages((req.params as any).id, page.provider),
          limit: page.limit,
          offset: page.offset,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_request";
        return reply.code(400).send({ error: message });
      }
    });
    app.get("/v1/nango-connectors/connections/:id/documents", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      try {
        return await manager.listDocuments((req.params as any).id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "document_list_failed";
        return reply.code(message === "document_connection_not_found" ? 404 : 500).send({ error: message, message });
      }
    });
    app.get("/v1/nango-connectors/connections/:id/documents/:documentId", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      try {
        const params = req.params as any;
        return await manager.readDocument(params.id, params.documentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "document_read_failed";
        const status = message === "document_too_large" ? 413 : message === "connector_document_store_unavailable" ? 500 : 404;
        return reply.code(status).send({ error: message, message });
      }
    });
    app.get("/v1/nango-connectors/connections/:id/records", async (req, reply) => {
      const type = (req.query as any)?.type ?? "mail";
      if (type !== "mail" && type !== "calendar")
        return reply.code(400).send({ error: "invalid_record_type" });
      try {
        const page = pageParams(req.query);
        return {
          items: manager.repository.records((req.params as any).id, type, page),
          total: manager.repository.countRecords((req.params as any).id, type, page.provider),
          limit: page.limit,
          offset: page.offset,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_request";
        return reply.code(400).send({ error: message });
      }
    });
    app.get("/v1/nango-connectors/failures", async () =>
      manager.repository.listFailures(),
    );
    app.post("/v1/nango-connectors/debug/faults", async (_req, reply) => {
      if (!enabled) return unavailable(reply);
      return reply
        .code(403)
        .send({
          error: "fault_injection_unavailable",
          message:
            "Fault injection is available only with a mock connector executor",
        });
    });
  };

