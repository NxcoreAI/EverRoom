import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { DataMigrationService, NormalizedExternalThread } from "./service.js";

const Provider = Type.Union([
  Type.Literal("notion"),
  Type.Literal("openclaw"),
  Type.Literal("codex"),
  Type.Literal("claude"),
]);
const Transport = Type.Union([
  Type.Literal("oauth"), Type.Literal("zip"), Type.Literal("local-sqlite"),
  Type.Literal("local-jsonl"), Type.Literal("archive"), Type.Literal("directory"),
]);

export function dataMigrationRoutes(service: DataMigrationService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/data-migrations/sources", async () => service.listSources());
    app.get("/v1/data-migrations/runs", {
      schema: { querystring: Type.Object({ sourceId: Type.Optional(Type.String({ maxLength: 100 })) }) },
    }, async (request) => service.listRuns(request.query.sourceId));

    app.post("/v1/data-migrations/runs", {
      schema: { body: Type.Object({ provider: Provider, transport: Transport,
        stableSourceKey: Type.String({ minLength: 1, maxLength: 512 }), displayName: Type.String({ minLength: 1, maxLength: 200 }) }) },
    }, async (request, reply) => reply.code(201).send(service.begin(request.body)));

    app.patch("/v1/data-migrations/runs/:id/progress", {
      schema: { params: Type.Object({ id: Type.String() }), body: Type.Object({
        phase: Type.Optional(Type.Union([Type.Literal("discovering"), Type.Literal("reading"), Type.Literal("normalizing"), Type.Literal("saving"), Type.Literal("memory"), Type.Literal("finalizing"), Type.Literal("completed")])),
        pagesTotal: Type.Optional(Type.Integer({ minimum: 0 })), pagesCompleted: Type.Optional(Type.Integer({ minimum: 0 })),
        threadsTotal: Type.Optional(Type.Integer({ minimum: 0 })), threadsCompleted: Type.Optional(Type.Integer({ minimum: 0 })),
        messagesTotal: Type.Optional(Type.Integer({ minimum: 0 })), messagesCompleted: Type.Optional(Type.Integer({ minimum: 0 })),
      }) },
    }, async (request) => service.updateProgress(request.params.id, request.body));

    app.post("/v1/data-migrations/runs/:id/threads", {
      bodyLimit: 512 * 1024 * 1024,
      schema: { params: Type.Object({ id: Type.String() }), body: Type.Object({ threads: Type.Array(Type.Object({
        stableKey: Type.String({ minLength: 1, maxLength: 512 }), agentId: Type.Optional(Type.String({ maxLength: 200 })),
        externalSessionId: Type.String({ minLength: 1, maxLength: 512 }), title: Type.String({ maxLength: 500 }),
        messages: Type.Array(Type.Object({ stableKey: Type.String({ maxLength: 512 }),
          role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
          content: Type.String({ minLength: 1, maxLength: 1_000_000 }), occurredAt: Type.String({ minLength: 10, maxLength: 50 }),
        }), { maxItems: 5_000 }),
      }), { minItems: 1, maxItems: 100 }) }) },
    }, async (request) => service.appendThreads(request.params.id, request.body.threads as NormalizedExternalThread[]));

    app.post("/v1/data-migrations/runs/:id/finish", {
      schema: { params: Type.Object({ id: Type.String() }), body: Type.Object({ fullScan: Type.Optional(Type.Boolean()) }) },
    }, async (request) => service.finish(request.params.id, request.body.fullScan !== false));
    app.post("/v1/data-migrations/runs/:id/fail", {
      schema: { params: Type.Object({ id: Type.String() }), body: Type.Object({ error: Type.String({ minLength: 1, maxLength: 2_000 }) }) },
    }, async (request) => service.fail(request.params.id, request.body.error));
    app.post("/v1/data-migrations/runs/:id/cancel", {
      schema: { params: Type.Object({ id: Type.String() }) },
    }, async (request) => service.cancel(request.params.id));
    app.delete("/v1/data-migrations/sources/:id", {
      schema: { params: Type.Object({ id: Type.String() }) },
    }, async (request, reply) => { await service.clear(request.params.id); return reply.code(204).send(); });

    app.get("/v1/data-migrations/conversations", {
      schema: { querystring: Type.Object({ query: Type.Optional(Type.String({ maxLength: 500 })), cursor: Type.Optional(Type.String({ maxLength: 100 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }) },
    }, async (request) => service.searchConversations(request.query.query ?? "", request.query.cursor, request.query.limit ?? 20));
    app.get("/v1/data-migrations/conversations/:id/preview", {
      schema: { params: Type.Object({ id: Type.String() }) },
    }, async (request) => service.preview(request.params.id));
  };
}
