import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  ConnectorConfigVersionConflictError,
  type ConnectorSyncJobInput,
  type ConnectorSyncService,
} from "./service.js";

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

export function connectorRoutes(service: ConnectorSyncService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/connectors/sync/status", { schema: { tags: ["connectors"] } }, async () => service.status(service.currentOwnerId()));
    app.get("/v1/connectors/accounts", { schema: { tags: ["connectors"] } }, async () => service.listAccounts());

    app.get(
      "/v1/connectors/prompt-profiles",
      {
        schema: {
          tags: ["connectors"],
          querystring: Type.Object({
            service: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            resourceType: Type.Optional(ResourceType),
          }),
        },
      },
      async (request) => service.listPromptProfiles(request.query.service, request.query.resourceType),
    );

    app.get("/v1/connectors/sync/jobs", { schema: { tags: ["connectors"] } }, async () => service.listJobs());

    app.post(
      "/v1/connectors/sync/jobs",
      { schema: { tags: ["connectors"], body: CreateJobBody } },
      async (request, reply) => {
        try {
          return reply.code(201).send(service.createJob(request.body as ConnectorSyncJobInput));
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    app.get(
      "/v1/connectors/sync/jobs/:id",
      { schema: { tags: ["connectors"], params: JobParams } },
      async (request, reply) => service.getJob(request.params.id)
        ?? reply.code(404).send({ error: "not_found", message: "Connector sync job not found" }),
    );

    app.patch(
      "/v1/connectors/sync/jobs/:id",
      { schema: { tags: ["connectors"], params: JobParams, body: UpdateJobBody } },
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
      "/v1/connectors/sync/jobs/:id",
      { schema: { tags: ["connectors"], params: JobParams, body: VersionBody } },
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
      "/v1/connectors/sync/jobs/:id/run",
      { schema: { tags: ["connectors"], params: JobParams } },
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
        `/v1/connectors/sync/jobs/:id/${path}`,
        { schema: { tags: ["connectors"], params: JobParams, body: VersionBody } },
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
      "/v1/connectors/sync/jobs/:id/versions",
      { schema: { tags: ["connectors"], params: JobParams } },
      async (request, reply) => {
        try { return service.listJobVersions(request.params.id); } catch (error) { return sendServiceError(reply, error); }
      },
    );

    app.get(
      "/v1/connectors/sync/jobs/:id/runs",
      {
        schema: {
          tags: ["connectors"], params: JobParams,
          querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
        },
      },
      async (request, reply) => {
        try { return service.listRuns(request.params.id, request.query.limit); } catch (error) { return sendServiceError(reply, error); }
      },
    );

    app.get(
      "/v1/connectors/sync/runs/:id",
      { schema: { tags: ["connectors"], params: RunParams } },
      async (request, reply) => service.getRun(request.params.id)
        ?? reply.code(404).send({ error: "not_found", message: "Connector sync run not found" }),
    );

    app.get(
      "/v1/connectors/sync/runs/:id/quarantine",
      { schema: { tags: ["connectors"], params: RunParams } },
      async (request, reply) => service.listRunQuarantine(request.params.id)
        ?? reply.code(404).send({ error: "not_found", message: "Connector sync run not found" }),
    );

    app.get(
      "/v1/connectors/data",
      {
        schema: {
          tags: ["connectors"],
          querystring: Type.Object({
            service: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            dataset: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            query: Type.Optional(Type.String({ maxLength: 500 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            includeExpired: Type.Optional(Type.Boolean()),
          }),
        },
      },
      async (request) => service.queryRecords({ ...request.query, ownerId: service.currentOwnerId() }),
    );

    app.get(
      "/v1/connectors/data/:id",
      { schema: { tags: ["connectors"], params: RunParams } },
      async (request, reply) => service.getRecord(service.currentOwnerId(), request.params.id)
        ?? reply.code(404).send({ error: "not_found", message: "Connector record not found" }),
    );
  };
}
