import type { FastifyPluginAsync } from "fastify";
import { isConnectorProvider, isSyncMode } from "@nxcore/connector-contract";
import type { ConnectorManager } from "./manager.js";
import {
  nangoAuthorizationErrorMessage,
  type NangoAuthorizationService,
} from "./nango-authorization.js";
export const connectorRoutes =
  (
    manager: ConnectorManager,
    enabled: boolean,
    authorization?: NangoAuthorizationService,
  ): FastifyPluginAsync =>
  async (app) => {
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
    app.get("/v1/connectors/status", async () => ({
      enabled,
      connections: manager.repository.listConnections(),
      scopes: scopes(),
      runs: manager.repository.listRuns(),
    }));
    app.get("/v1/connectors/connections", async () =>
      manager.repository.listConnections(),
    );
    app.post("/v1/connectors/authorizations", async (req, reply) => {
      if (!enabled || !authorization) return unavailable(reply);
      const provider = (req.body as any)?.provider;
      if (!isConnectorProvider(provider))
        return reply.code(400).send({ error: "invalid_provider" });
      try {
        return reply.code(201).send(await authorization.start(provider));
      } catch (error) {
        return reply.code(502).send({
          error: "authorization_start_failed",
          message: nangoAuthorizationErrorMessage(
            error,
            "Unable to start Nango authorization",
          ),
        });
      }
    });
    app.get("/v1/connectors/authorizations/:id", async (req, reply) => {
      if (!enabled || !authorization) return unavailable(reply);
      try {
        const attempt = await authorization.status((req.params as any).id);
        return attempt ?? reply.code(404).send({ error: "authorization_not_found" });
      } catch (error) {
        return reply.code(502).send({
          error: "authorization_status_failed",
          message: nangoAuthorizationErrorMessage(
            error,
            "Unable to read Nango authorization status",
          ),
        });
      }
    });
    app.post("/v1/connectors/connections", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      const b = req.body as any;
      if (
        !isConnectorProvider(b?.provider) ||
        typeof b?.nangoConnectionId !== "string" ||
        typeof b?.nangoConfigKey !== "string"
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
    app.post("/v1/connectors/connections/:id/disable", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      manager.repository.disableConnection((req.params as any).id);
      return { ok: true };
    });
    app.delete("/v1/connectors/connections/:id", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      manager.repository.purgeConnection((req.params as any).id);
      return { ok: true };
    });
    app.get("/v1/connectors/scopes", async () => scopes());
    app.get("/v1/connectors/runs", async () => manager.repository.listRuns());
    app.post("/v1/connectors/runs/:id/cancel", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      return (
        manager.cancel((req.params as any).id) ??
        reply.code(404).send({ error: "run_not_found" })
      );
    });
    app.post("/v1/connectors/scopes/:id/sync", async (req, reply) => {
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
    app.get("/v1/connectors/connections/:id/messages", async (req) =>
      manager.repository.messages((req.params as any).id),
    );
    app.get("/v1/connectors/connections/:id/documents", async (req, reply) => {
      if (!enabled) return unavailable(reply);
      try {
        return await manager.listDocuments((req.params as any).id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "document_list_failed";
        return reply.code(message === "document_connection_not_found" ? 404 : 500).send({ error: message, message });
      }
    });
    app.get("/v1/connectors/connections/:id/documents/:documentId", async (req, reply) => {
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
    app.get("/v1/connectors/connections/:id/records", async (req, reply) => {
      const type = (req.query as any)?.type ?? "mail";
      if (type !== "mail" && type !== "calendar")
        return reply.code(400).send({ error: "invalid_record_type" });
      return manager.repository.records((req.params as any).id, type);
    });
    app.get("/v1/connectors/failures", async () =>
      manager.repository.listFailures(),
    );
    app.post("/v1/connectors/debug/faults", async (_req, reply) => {
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
