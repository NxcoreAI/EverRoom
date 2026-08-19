import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { ConnectorSyncService } from "./service.js";

const JobParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) });

export function connectorRoutes(service: ConnectorSyncService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/connectors/sync/status",
      {
        schema: {
          tags: ["connectors"],
          querystring: Type.Object({
            ownerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          }),
        },
      },
      async (request) => service.status(request.query.ownerId),
    );

    app.get(
      "/v1/connectors/sync/jobs",
      {
        schema: {
          tags: ["connectors"],
          querystring: Type.Object({
            ownerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          }),
        },
      },
      async (request) => service.listJobs(request.query.ownerId),
    );

    app.post(
      "/v1/connectors/sync/jobs/:id/run",
      { schema: { tags: ["connectors"], params: JobParams } },
      async (request, reply) => {
        const job = await service.triggerJob(request.params.id);
        return job ? job : reply.code(404).send({ error: "not_found", message: "Connector sync job not found" });
      },
    );

    app.get(
      "/v1/connectors/data",
      {
        schema: {
          tags: ["connectors"],
          querystring: Type.Object({
            ownerId: Type.String({ minLength: 1, maxLength: 128 }),
            service: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            dataset: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            query: Type.Optional(Type.String({ maxLength: 500 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            includeExpired: Type.Optional(Type.Boolean()),
          }),
        },
      },
      async (request) => service.queryRecords(request.query),
    );

    app.get(
      "/v1/connectors/data/:id",
      {
        schema: {
          tags: ["connectors"],
          params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) }),
          querystring: Type.Object({ ownerId: Type.String({ minLength: 1, maxLength: 128 }) }),
        },
      },
      async (request, reply) => {
        const record = service.getRecord(request.query.ownerId, request.params.id);
        return record ?? reply.code(404).send({ error: "not_found", message: "Connector record not found" });
      },
    );
  };
}
