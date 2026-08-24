import type { FastifyPluginAsync } from "fastify";
import { isConnectorProvider, isSyncMode } from "@nxcore/connector-contract";
import type { ConnectorManager } from "./manager.js";
import {
  nangoAuthorizationErrorMessage,
  type NangoAuthorizationService,
} from "./nango-authorization.js";
const pageParams = (query: any) => {
  const limit = query?.limit === undefined ? 200 : Number(query.limit);
  const offset = query?.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1 || limit > 500 || offset < 0)
    throw Object.assign(new Error("invalid_page"), { statusCode: 400 });
  const provider = query?.provider;
  if (provider !== undefined && !isConnectorProvider(provider))
    throw Object.assign(new Error("invalid_provider"), { statusCode: 400 });
  return { limit, offset, ...(provider ? { provider } : {}) };
};
export const nangoConnectorRoutes =
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
    app.get("/v1/nango-connectors/status", async () => ({
      enabled,
      connections: manager.repository.listConnections(),
      scopes: scopes(),
      runs: manager.repository.listRuns(),
    }));
    app.get("/v1/nango-connectors/connections", async () =>
      manager.repository.listConnections(),
    );
    app.post("/v1/nango-connectors/authorizations", async (req, reply) => {
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
    app.get("/v1/nango-connectors/authorizations/:id", async (req, reply) => {
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
    app.post("/v1/nango-connectors/connections", async (req, reply) => {
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
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  ConnectorConfigVersionConflictError,
  type ConnectorSyncJobInput,
  type ConnectorSyncService,
} from "./service.js";
import type { IngestService } from "../ingest/service.js";
import type { RefSourceKind } from "../ingest/types.js";
import type { ConnectorMarkdownService } from "./markdown-service.js";

const JobParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) });
const RunParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) });
const ResourceType = Type.Union([
  Type.Literal("email"), Type.Literal("document"), Type.Literal("calendar"), Type.Literal("generic"),
]);
const JobStatus = Type.Union([
  Type.Literal("draft"), Type.Literal("active"), Type.Literal("paused"), Type.Literal("archived"),
]);
const ScheduleType = Type.Union([Type.Literal("manual"), Type.Literal("interval")]);
const RetryPolicy = Type.Object({
  maxAttempts: Type.Integer({ minimum: 1, maximum: 10 }),
  baseDelayMs: Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
});
const JobFields = {
  name: Type.String({ minLength: 1, maxLength: 160 }),
  service: Type.String({ minLength: 1, maxLength: 128 }),
  dataset: Type.String({ minLength: 1, maxLength: 128 }),
  resourceType: ResourceType,
  connectionName: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()])),
  allowedActions: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 50 }),
  input: Type.Record(Type.String(), Type.Unknown()),
  goal: Type.String({ minLength: 1, maxLength: 4_000 }),
  promptProfileId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()])),
  promptOverride: Type.Optional(Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()])),
  schemaVersion: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
  scheduleType: ScheduleType,
  intervalMs: Type.Integer({ minimum: 5_000, maximum: 31_536_000_000 }),
  timezone: Type.String({ minLength: 1, maxLength: 128 }),
  retryPolicy: Type.Optional(RetryPolicy),
  priority: Type.Optional(Type.Integer({ minimum: -100, maximum: 100 })),
  status: JobStatus,
};
const CreateJobBody = Type.Object(JobFields, { additionalProperties: false });
const UpdateJobBody = Type.Intersect([
  Type.Partial(Type.Object(JobFields)),
  Type.Object({ configVersion: Type.Integer({ minimum: 1 }) }),
]);
const VersionBody = Type.Object({ configVersion: Type.Integer({ minimum: 1 }) });

function sendServiceError(reply: { code(statusCode: number): { send(value: unknown): unknown } }, error: unknown) {
  if (error instanceof ConnectorConfigVersionConflictError) {
    return reply.code(409).send({ error: "version_conflict", message: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  const notFound = /not found/i.test(message);
  return reply.code(notFound ? 404 : 400).send({ error: notFound ? "not_found" : "invalid_request", message });
}

export function cliConnectorRoutes(
  service: ConnectorSyncService,
  ingest: IngestService,
  markdown?: ConnectorMarkdownService,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/cli-connectors/sync/status", { schema: { tags: ["cli-connectors"] } }, async () => ({
      ...service.status(service.currentOwnerId()),
      ...(markdown ? { markdown: markdown.stats(service.currentOwnerId()) } : {}),
    }));
    app.get("/v1/cli-connectors/accounts", { schema: { tags: ["cli-connectors"] } }, async () => service.listAccounts());

    app.get(
      "/v1/cli-connectors/prompt-profiles",
      {
        schema: {
          tags: ["cli-connectors"],
          querystring: Type.Object({
            service: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            resourceType: Type.Optional(ResourceType),
          }),
        },
      },
      async (request) => service.listPromptProfiles(request.query.service, request.query.resourceType),
    );

    app.get("/v1/cli-connectors/sync/jobs", { schema: { tags: ["cli-connectors"] } }, async () => service.listJobs());

    app.post(
      "/v1/cli-connectors/sync/jobs",
      { schema: { tags: ["cli-connectors"], body: CreateJobBody } },
      async (request, reply) => {
        try {
          return reply.code(201).send(service.createJob(request.body as ConnectorSyncJobInput));
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    app.get(
      "/v1/cli-connectors/sync/jobs/:id",
      { schema: { tags: ["cli-connectors"], params: JobParams } },
      async (request, reply) => service.getJob(request.params.id)
        ?? reply.code(404).send({ error: "not_found", message: "Connector sync job not found" }),
    );

    app.patch(
      "/v1/cli-connectors/sync/jobs/:id",
      { schema: { tags: ["cli-connectors"], params: JobParams, body: UpdateJobBody } },
      async (request, reply) => {
        try {
          return service.updateJob(request.params.id, request.body)
            ?? reply.code(404).send({ error: "not_found", message: "Connector sync job not found" });
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    app.delete(
      "/v1/cli-connectors/sync/jobs/:id",
      { schema: { tags: ["cli-connectors"], params: JobParams, body: VersionBody } },
      async (request, reply) => {
        try {
          return service.setJobStatus(request.params.id, "archived", request.body.configVersion)
            ?? reply.code(404).send({ error: "not_found", message: "Connector sync job not found" });
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    app.post(
      "/v1/cli-connectors/sync/jobs/:id/run",
      { schema: { tags: ["cli-connectors"], params: JobParams } },
      async (request, reply) => {
        try {
          const job = await service.triggerJob(request.params.id);
          return job ?? reply.code(404).send({ error: "not_found", message: "Connector sync job not found" });
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    for (const [path, status] of [["pause", "paused"], ["resume", "active"]] as const) {
      app.post(
        `/v1/cli-connectors/sync/jobs/:id/${path}`,
        { schema: { tags: ["cli-connectors"], params: JobParams, body: VersionBody } },
        async (request, reply) => {
          try {
            return service.setJobStatus(request.params.id, status, request.body.configVersion)
              ?? reply.code(404).send({ error: "not_found", message: "Connector sync job not found" });
          } catch (error) {
            return sendServiceError(reply, error);
          }
        },
      );
    }

    app.get(
      "/v1/cli-connectors/sync/jobs/:id/versions",
      { schema: { tags: ["cli-connectors"], params: JobParams } },
      async (request, reply) => {
        try { return service.listJobVersions(request.params.id); } catch (error) { return sendServiceError(reply, error); }
      },
    );

    app.get(
      "/v1/cli-connectors/sync/jobs/:id/runs",
      {
        schema: {
          tags: ["cli-connectors"], params: JobParams,
          querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
        },
      },
      async (request, reply) => {
        try { return service.listRuns(request.params.id, request.query.limit); } catch (error) { return sendServiceError(reply, error); }
      },
    );

    app.get(
      "/v1/cli-connectors/sync/runs/:id",
      { schema: { tags: ["cli-connectors"], params: RunParams } },
      async (request, reply) => service.getRun(request.params.id)
        ?? reply.code(404).send({ error: "not_found", message: "Connector sync run not found" }),
    );

    app.get(
      "/v1/cli-connectors/sync/runs/:id/quarantine",
      { schema: { tags: ["cli-connectors"], params: RunParams } },
      async (request, reply) => service.listRunQuarantine(request.params.id)
        ?? reply.code(404).send({ error: "not_found", message: "Connector sync run not found" }),
    );

    app.get(
      "/v1/cli-connectors/data",
      {
        schema: {
          tags: ["cli-connectors"],
          querystring: Type.Object({
            service: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            dataset: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            query: Type.Optional(Type.String({ maxLength: 500 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            offset: Type.Optional(Type.Integer({ minimum: 0 })),
            includeExpired: Type.Optional(Type.Boolean()),
          }),
        },
      },
      async (request) => service.queryRecordPage({ ...request.query, ownerId: service.currentOwnerId() }),
    );

    app.post(
      "/v1/cli-connectors/data/ingest",
      {
        schema: {
          tags: ["cli-connectors", "ingest"],
          body: Type.Object({
            recordIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 100 }),
          }),
        },
      },
      async (request) => {
        const ownerId = service.currentOwnerId();
        const recordIds = [...new Set(request.body.recordIds)];
        const items = [] as Array<{
          recordId: string;
          eventId: string | null;
          deduped: boolean;
          routeJobId: string | null;
          error: string | null;
        }>;
        for (const recordId of recordIds) {
          const record = service.getRecord(ownerId, recordId);
          if (!record) {
            items.push({ recordId, eventId: null, deduped: false, routeJobId: null, error: "Connector record not found" });
            continue;
          }
          const sourceKindByResource: Partial<Record<typeof record.resourceType, RefSourceKind>> = {
            email: "connector-email",
            document: "connector-document",
            calendar: "connector-calendar",
            generic: "connector-record",
          };
          const sourceKind = sourceKindByResource[record.resourceType];
          if (!sourceKind) {
            items.push({ recordId, eventId: null, deduped: false, routeJobId: null, error: "Unsupported connector record type" });
            continue;
          }
          try {
            const result = await ingest.ingest({
              source: { ref: { sourceKind, sourceId: recordId } },
              originChannel: "connector",
            });
            items.push({
              recordId,
              eventId: result.eventId,
              deduped: result.deduped,
              routeJobId: result.routeJobId,
              error: null,
            });
          } catch (error) {
            items.push({
              recordId,
              eventId: null,
              deduped: false,
              routeJobId: null,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return {
          items,
          imported: items.filter((item) => !item.error && !item.deduped).length,
          deduped: items.filter((item) => !item.error && item.deduped).length,
          failed: items.filter((item) => item.error).length,
        };
      },
    );

    app.get(
      "/v1/cli-connectors/data/:id",
      { schema: { tags: ["cli-connectors"], params: RunParams } },
      async (request, reply) => {
        const record = service.getRecord(service.currentOwnerId(), request.params.id);
        if (!record) return reply.code(404).send({ error: "not_found", message: "Connector record not found" });
        const resourceType = record.resourceType === "email"
          || record.resourceType === "document"
          || record.resourceType === "calendar"
          ? record.resourceType
          : record.resourceType === "generic" ? "generic" : null;
        const artifact = markdown && resourceType
          ? markdown.getByIngestSource(resourceType, record.id)
          : null;
        return {
          ...record,
          markdownArtifact: artifact ? {
            id: artifact.id,
            version: artifact.version,
            status: artifact.status,
            ingestStatus: artifact.ingestStatus,
            markdownContentHash: artifact.markdownContentHash,
            ingestEventId: artifact.ingestEventId,
            updatedAt: artifact.updatedAt.toISOString(),
          } : null,
        };
      },
    );
  };
}

/** Legacy path aliases retained for clients released before the CLI connector rename. */
export function connectorSyncRoutes(service: ConnectorSyncService): FastifyPluginAsync {
  return async (app) => {
    app.post("/v1/connectors/sync/jobs", async (request, reply) => {
      try { return reply.code(201).send(service.createJob(request.body as any)); }
      catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid_job" }); }
    });
    app.patch("/v1/connectors/sync/jobs/:id", async (request, reply) => {
      try {
        const result = service.updateJob((request.params as any).id, request.body as any);
        return result ?? reply.code(404).send({ error: "not_found" });
      } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "update_failed" }); }
    });
    app.post("/v1/connectors/sync/jobs/:id/pause", async (request, reply) => {
      try {
        const result = service.setJobStatus((request.params as any).id, "paused", (request.body as any)?.configVersion);
        return result ?? reply.code(404).send({ error: "not_found" });
      } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "pause_failed" }); }
    });
  };
}
