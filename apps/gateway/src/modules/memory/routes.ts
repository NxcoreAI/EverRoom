import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { MemoryGatewayError } from "./errors.js";
import type { MemoryService } from "./service.js";

const AtomicType = Type.Union([
  Type.Literal("episodic"),
  Type.Literal("persona"),
  Type.Literal("instruction"),
]);

const ListQuery = Type.Object({
  type: Type.Optional(AtomicType),
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
  offset: Type.Integer({ minimum: 0, default: 0 }),
  timeStart: Type.Optional(Type.String({ minLength: 4, maxLength: 40 })),
  timeEnd: Type.Optional(Type.String({ minLength: 4, maxLength: 40 })),
});

const ConversationListQuery = Type.Object({
  sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
  offset: Type.Integer({ minimum: 0, default: 0 }),
  timeStart: Type.Optional(Type.String({ minLength: 4, maxLength: 40 })),
  timeEnd: Type.Optional(Type.String({ minLength: 4, maxLength: 40 })),
});

const AtomicDtoSchema = Type.Object({
  id: Type.String(),
  type: Type.String(),
  content: Type.String(),
  background: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const ConversationMessageDtoSchema = Type.Object({
  id: Type.String(),
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  content: Type.String(),
  timestamp: Type.Union([Type.String(), Type.Null()]),
  sessionId: Type.Union([Type.String(), Type.Null()]),
});

const SourceDocumentInput = Type.Object({
  sourceId: Type.String({ minLength: 1, maxLength: 100 }),
  sourceKind: Type.String({ minLength: 1, maxLength: 50 }),
  documentId: Type.String({ minLength: 1, maxLength: 200 }),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  markdown: Type.String({ minLength: 1, maxLength: 500_000 }),
  uri: Type.Optional(Type.String({ maxLength: 2_000 })),
  contentHash: Type.Optional(Type.String({ maxLength: 128 })),
});

const ScenarioEntryDtoSchema = Type.Object({
  path: Type.String(),
  summary: Type.Union([Type.String(), Type.Null()]),
  isDirectory: Type.Boolean(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export function memoryRoutes(service: MemoryService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/memory/overview",
      { schema: { tags: ["memory"] } },
      async () => service.overview(),
    );

    app.get(
      "/v1/memory/atomic",
      {
        schema: {
          tags: ["memory"],
          querystring: ListQuery,
          response: {
            200: Type.Object({
              items: Type.Array(AtomicDtoSchema),
              total: Type.Integer(),
            }),
          },
        },
      },
      async (request) => service.listAtomic({
        type: request.query.type,
        limit: request.query.limit,
        offset: request.query.offset,
        timeStart: request.query.timeStart,
        timeEnd: request.query.timeEnd,
      }),
    );

    app.post(
      "/v1/memory/atomic/search",
      {
        schema: {
          tags: ["memory"],
          body: Type.Object({
            query: Type.String({ minLength: 1, maxLength: 2048 }),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
            type: Type.Optional(AtomicType),
          }),
        },
      },
      async (request) => service.searchAtomic(request.body.query, request.body.limit ?? 10),
    );

    app.patch(
      "/v1/memory/atomic/:id",
      {
        schema: {
          tags: ["memory"],
          params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }),
          body: Type.Object({
            content: Type.String({ minLength: 1, maxLength: 8192 }),
            background: Type.Optional(Type.String({ maxLength: 2048 })),
          }),
        },
      },
      async (request) => service.updateAtomic(
        request.params.id,
        request.body.content,
        request.body.background,
      ),
    );

    app.delete(
      "/v1/memory/atomic",
      {
        schema: {
          tags: ["memory"],
          body: Type.Object({
            ids: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
              minItems: 1,
              maxItems: 5000,
            }),
          }),
        },
      },
      async (request) => service.deleteAtomic(request.body.ids),
    );

    app.get(
      "/v1/memory/scenario",
      {
        schema: {
          tags: ["memory"],
          querystring: Type.Object({
            pathPrefix: Type.Optional(Type.String({ maxLength: 1024 })),
          }),
          response: {
            200: Type.Object({
              entries: Type.Array(ScenarioEntryDtoSchema),
              total: Type.Integer(),
            }),
          },
        },
      },
      async (request) => service.listScenarios(request.query.pathPrefix),
    );

    app.get(
      "/v1/memory/scenario/content",
      {
        schema: {
          tags: ["memory"],
          querystring: Type.Object({
            path: Type.String({ minLength: 1, maxLength: 1024 }),
          }),
        },
      },
      async (request) => service.readScenario(request.query.path),
    );

    app.get(
      "/v1/memory/core",
      { schema: { tags: ["memory"] } },
      async () => service.readCore(),
    );

    app.put(
      "/v1/memory/core",
      {
        schema: {
          tags: ["memory"],
          body: Type.Object({
            content: Type.String({ minLength: 1, maxLength: 65536 }),
          }),
        },
      },
      async (request, reply) => {
        const result = await service.writeCore(request.body.content);
        return reply.code(200).send(result);
      },
    );

    app.get(
      "/v1/memory/conversation",
      {
        schema: {
          tags: ["memory"],
          querystring: ConversationListQuery,
          response: {
            200: Type.Object({
              messages: Type.Array(ConversationMessageDtoSchema),
              total: Type.Integer(),
            }),
          },
        },
      },
      async (request) => service.listConversations({
        sessionId: request.query.sessionId,
        limit: request.query.limit,
        offset: request.query.offset,
        timeStart: request.query.timeStart,
        timeEnd: request.query.timeEnd,
      }),
    );

    app.post(
      "/v1/memory/conversation/search",
      {
        schema: {
          tags: ["memory"],
          body: Type.Object({
            query: Type.String({ minLength: 1, maxLength: 2048 }),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
            sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          }),
        },
      },
      async (request) => service.searchConversations(
        request.body.query,
        request.body.limit ?? 10,
        request.body.sessionId,
      ),
    );

    app.delete(
      "/v1/memory/conversation",
      {
        schema: {
          tags: ["memory"],
          body: Type.Object({
            sessionIds: Type.Optional(Type.Array(
              Type.String({ minLength: 1, maxLength: 100 }),
              { minItems: 1, maxItems: 100 },
            )),
            messageIds: Type.Optional(Type.Array(
              Type.String({ minLength: 1, maxLength: 200 }),
              { minItems: 1, maxItems: 5000 },
            )),
          }),
        },
      },
      async (request) => {
        const { sessionIds, messageIds } = request.body;
        if (!sessionIds && !messageIds) {
          throw new MemoryGatewayError("memory_error", "sessionIds or messageIds is required", 400);
        }
        return service.deleteConversations({ sessionIds, messageIds });
      },
    );

    app.post(
      "/v1/memory/document-rewrite",
      {
        schema: {
          tags: ["memory"],
          body: Type.Object({
            roomId: Type.String({ minLength: 1, maxLength: 100 }),
            documentId: Type.String({ minLength: 1, maxLength: 100 }),
            documentTitle: Type.String({ minLength: 1, maxLength: 120 }),
            instruction: Type.String({ minLength: 1, maxLength: 4_000 }),
            originalText: Type.String({ minLength: 1, maxLength: 100_000 }),
            replacementText: Type.String({ minLength: 1, maxLength: 100_000 }),
          }),
        },
      },
      async (request) => ({ captured: await service.captureSelectionRewrite(request.body) }),
    );

    app.post(
      "/v1/memory/source-document",
      { schema: { tags: ["memory"], body: SourceDocumentInput } },
      async (request) => ({ captured: await service.captureSourceDocument(request.body) }),
    );
  };
}
