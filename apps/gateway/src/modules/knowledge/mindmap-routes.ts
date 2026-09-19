/**
 * 聚焦思维导图路由（思路板块聚焦模式改造）：
 * - GET  /v1/knowledge/rooms/:id/mindmap?scope&documentId&requestVersion
 *   读行 + 重启对账；无行懒 kick；ready 附 projection。
 * - POST /v1/knowledge/rooms/:id/mindmap/ensure 幂等 kick（force=true 重生成）。
 *
 * response 故意不写 TypeBox schema（沿 emergence-routes 惯例）：
 * 穷举 schema 的静默剥字段风险大于文档收益；契约以
 * apps/desktop/src/shared/knowledge.ts 的镜像 DTO 为准。
 */

import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { FocusMindmapService, MindmapServiceError } from "./mindmap-service.js";

const ScopeParam = Type.Union([Type.Literal("room"), Type.Literal("document")]);

const MindmapQuery = Type.Object({
  scope: ScopeParam,
  documentId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])),
  requestVersion: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const MindmapEnsureBody = Type.Object({
  scope: ScopeParam,
  documentId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])),
  force: Type.Optional(Type.Boolean()),
  requestVersion: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const RoomParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) });

export function mindmapRoutes(service: FocusMindmapService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/knowledge/rooms/:id/mindmap",
      {
        schema: {
          tags: ["knowledge"],
          params: RoomParams,
          querystring: MindmapQuery,
        },
      },
      async (request, reply) => {
        try {
          return await service.get(
            request.params.id,
            request.query.scope,
            request.query.documentId ?? null,
            request.query.requestVersion,
          );
        } catch (error) {
          if (error instanceof MindmapServiceError) {
            reply.code(error.statusCode);
            return { error: error.message };
          }
          throw error;
        }
      },
    );

    app.post(
      "/v1/knowledge/rooms/:id/mindmap/ensure",
      {
        schema: {
          tags: ["knowledge"],
          params: RoomParams,
          body: MindmapEnsureBody,
        },
      },
      async (request, reply) => {
        try {
          return await service.ensure(request.params.id, {
            scope: request.body.scope,
            documentId: request.body.documentId ?? null,
            ...(request.body.force !== undefined ? { force: request.body.force } : {}),
            requestVersion: request.body.requestVersion,
          });
        } catch (error) {
          if (error instanceof MindmapServiceError) {
            reply.code(error.statusCode);
            return { error: error.message };
          }
          throw error;
        }
      },
    );
  };
}
