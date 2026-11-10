import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { SearchService } from "./service.js";

const ItemType = Type.Union([
  Type.Literal("file"),
  Type.Literal("message"),
  Type.Literal("document"),
  Type.Literal("export"),
]);

const SearchHitDto = Type.Object({
  id: Type.String(),
  itemType: ItemType,
  refId: Type.String(),
  title: Type.String(),
  snippet: Type.String(),
  sourceKind: Type.Union([Type.String(), Type.Null()]),
  roomIds: Type.Array(Type.String()),
  occurredAt: Type.Union([Type.String(), Type.Null()]),
  ingestedAt: Type.String(),
  timeBasis: Type.Union([Type.Literal("occurred"), Type.Literal("ingested")]),
  versionLabel: Type.Union([Type.String(), Type.Null()]),
  fileVersionId: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([Type.Literal("meta_only"), Type.Literal("indexed"), Type.Literal("failed")]),
  sessionId: Type.Union([Type.String(), Type.Null()]),
  pageId: Type.Union([Type.String(), Type.Null()]),
});

const ScopeDto = Type.Object({
  indexedCount: Type.Integer(),
  pendingCount: Type.Integer(),
});

const SearchBody = Type.Object({
  query: Type.String({ maxLength: 2048, default: "" }),
  types: Type.Optional(Type.Array(ItemType, { maxItems: 4 })),
  timeBasis: Type.Optional(Type.Union([Type.Literal("occurred"), Type.Literal("ingested")])),
  from: Type.Optional(Type.Integer({ minimum: 0 })),
  to: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Integer({ minimum: 1, maximum: 50, default: 20 }),
  offset: Type.Integer({ minimum: 0, default: 0 }),
});

export function searchRoutes(service: SearchService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post(
      "/v1/search",
      {
        schema: {
          tags: ["search"],
          body: SearchBody,
          response: {
            200: Type.Object({
              items: Type.Array(SearchHitDto),
              total: Type.Integer(),
              scope: ScopeDto,
              // 二期记忆/Wiki provider 的占位契约：当前恒为空数组。
              providers: Type.Array(Type.String()),
            }),
          },
        },
      },
      async (request) => {
        const body = request.body;
        const page = service.search(
          body.query,
          {
            types: body.types,
            timeBasis: body.timeBasis,
            ...(body.timeBasis && body.from !== undefined && body.to !== undefined
              ? { from: body.from, to: body.to }
              : {}),
          },
          body.limit,
          body.offset,
        );
        return { ...page, providers: [] };
      },
    );

    app.get(
      "/v1/search/status",
      {
        schema: {
          tags: ["search"],
          response: { 200: ScopeDto },
        },
      },
      async () => service.status(),
    );

    app.post(
      "/v1/search/prioritize",
      {
        schema: {
          tags: ["search"],
          body: Type.Object({
            itemType: ItemType,
            refId: Type.String({ minLength: 1, maxLength: 200 }),
          }),
          response: { 200: Type.Object({ ok: Type.Boolean() }) },
        },
      },
      async (request) => ({ ok: service.prioritize(request.body.itemType, request.body.refId) }),
    );

    app.get(
      "/v1/search/message-context",
      {
        schema: {
          tags: ["search"],
          querystring: Type.Object({
            messageId: Type.String({ minLength: 1, maxLength: 100 }),
            before: Type.Integer({ minimum: 0, maximum: 50, default: 5 }),
            after: Type.Integer({ minimum: 0, maximum: 50, default: 5 }),
          }),
          response: {
            200: Type.Object({
              sessionId: Type.String(),
              messages: Type.Array(Type.Object({
                id: Type.String(),
                role: Type.String(),
                content: Type.String(),
                createdAt: Type.String(),
              })),
            }),
            404: Type.Object({ message: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const result = service.messageContext(
          request.query.messageId,
          request.query.before,
          request.query.after,
        );
        if (!result) return reply.code(404).send({ message: "message_not_found" });
        return result;
      },
    );
  };
}
