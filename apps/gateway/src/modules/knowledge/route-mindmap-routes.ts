/**
 * 写作路线导图路由（聚焦改版 2026-09）：
 * - GET  /v1/knowledge/rooms/:id/route-mindmap?documentId&requestVersion
 *   读行 + 重启对账；不懒 kick（生成只由创建动作触发）。
 * - POST …/start|expand|back|skip|finalize 五动作。
 *
 * response 故意不写 TypeBox schema（沿 emergence-routes 惯例）：
 * 穷举 schema 的静默剥字段风险大于文档收益；契约以
 * apps/desktop/src/shared/knowledge.ts 的镜像 DTO 为准。
 */

import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { RouteMindmapService, RouteMindmapServiceError } from "./route-mindmap-service.js";

const DocumentId = Type.String({ minLength: 1, maxLength: 200 });

const RoomParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) });

const RouteMindmapQuery = Type.Object({
  documentId: DocumentId,
  requestVersion: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const StartBody = Type.Object({
  documentId: DocumentId,
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
  requestVersion: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const ExpandBody = Type.Object({
  documentId: DocumentId,
  nodeRef: Type.String({ minLength: 1, maxLength: 200 }),
  requestVersion: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const BackBody = Type.Object({
  documentId: DocumentId,
  toDepth: Type.Integer({ minimum: 0, maximum: 63 }),
  requestVersion: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const SimpleBody = Type.Object({
  documentId: DocumentId,
  requestVersion: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export function routeMindmapRoutes(service: RouteMindmapService): FastifyPluginAsyncTypebox {
  return async (app) => {
    const handleError = (error: unknown, reply: { code(code: number): unknown }) => {
      if (error instanceof RouteMindmapServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      throw error;
    };

    app.get(
      "/v1/knowledge/rooms/:id/route-mindmap",
      {
        schema: {
          tags: ["knowledge"],
          params: RoomParams,
          querystring: RouteMindmapQuery,
        },
      },
      async (request, reply) => {
        try {
          return await service.get(request.params.id, request.query.documentId, request.query.requestVersion);
        } catch (error) {
          return handleError(error, reply);
        }
      },
    );

    app.post(
      "/v1/knowledge/rooms/:id/route-mindmap/start",
      {
        schema: {
          tags: ["knowledge"],
          params: RoomParams,
          body: StartBody,
        },
      },
      async (request, reply) => {
        try {
          return await service.start(request.params.id, {
            documentId: request.body.documentId,
            ...(request.body.title !== undefined ? { title: request.body.title } : {}),
            ...(request.body.description !== undefined ? { description: request.body.description } : {}),
            requestVersion: request.body.requestVersion,
          });
        } catch (error) {
          return handleError(error, reply);
        }
      },
    );

    app.post(
      "/v1/knowledge/rooms/:id/route-mindmap/expand",
      {
        schema: {
          tags: ["knowledge"],
          params: RoomParams,
          body: ExpandBody,
        },
      },
      async (request, reply) => {
        try {
          return await service.expand(request.params.id, {
            documentId: request.body.documentId,
            nodeRef: request.body.nodeRef,
            requestVersion: request.body.requestVersion,
          });
        } catch (error) {
          return handleError(error, reply);
        }
      },
    );

    app.post(
      "/v1/knowledge/rooms/:id/route-mindmap/back",
      {
        schema: {
          tags: ["knowledge"],
          params: RoomParams,
          body: BackBody,
        },
      },
      async (request, reply) => {
        try {
          return await service.back(request.params.id, {
            documentId: request.body.documentId,
            toDepth: request.body.toDepth,
            requestVersion: request.body.requestVersion,
          });
        } catch (error) {
          return handleError(error, reply);
        }
      },
    );

    app.post(
      "/v1/knowledge/rooms/:id/route-mindmap/skip",
      {
        schema: {
          tags: ["knowledge"],
          params: RoomParams,
          body: SimpleBody,
        },
      },
      async (request, reply) => {
        try {
          return await service.skip(request.params.id, {
            documentId: request.body.documentId,
            requestVersion: request.body.requestVersion,
          });
        } catch (error) {
          return handleError(error, reply);
        }
      },
    );

    app.post(
      "/v1/knowledge/rooms/:id/route-mindmap/finalize",
      {
        schema: {
          tags: ["knowledge"],
          params: RoomParams,
          body: SimpleBody,
        },
      },
      async (request, reply) => {
        try {
          return await service.finalize(request.params.id, {
            documentId: request.body.documentId,
            requestVersion: request.body.requestVersion,
          });
        } catch (error) {
          return handleError(error, reply);
        }
      },
    );
  };
}
