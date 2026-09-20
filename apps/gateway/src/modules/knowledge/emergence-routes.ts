/**
 * 知识涌现路由：POST /v1/knowledge/rooms/:id/emergence。
 *
 * response 故意不写 TypeBox schema（学 context-rooms overview 惯例）：
 * ProjectionResult 字段随 PRD 演化快，穷举 schema 的静默剥字段风险
 * 大于文档收益；契约以 apps/desktop/src/shared/knowledge.ts 的镜像 DTO 为准。
 */

import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { EmergenceService, EmergenceServiceError } from "./emergence-service.js";

const EmergenceRequestBody = Type.Object({
  mode: Type.Union([Type.Literal("focus"), Type.Literal("wander")]),
  focus: Type.Object({
    documentId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])),
    selectionText: Type.Optional(Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()])),
    blockId: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
    board: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
    level: Type.Optional(Type.Union([
      Type.Literal("selection"),
      Type.Literal("chapter"),
      Type.Literal("document"),
      Type.Literal("room"),
      Type.Null(),
    ])),
    trigger: Type.Optional(Type.Union([
      Type.Literal("selection-settle"),
      Type.Literal("chapter-stable"),
      Type.Literal("document-open"),
      Type.Literal("panel-open"),
      Type.Literal("board-switch"),
      Type.Null(),
    ])),
    chapter: Type.Optional(Type.Union([
      Type.Object({
        heading: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
        bodyText: Type.String({ maxLength: 2_000_000 }),
      }),
      Type.Null(),
    ])),
  }),
  wander: Type.Optional(Type.Union([
    Type.Object({
      startNodeRef: Type.Optional(Type.Union([Type.String({ maxLength: 300 }), Type.Null()])),
      seed: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    }),
    Type.Null(),
  ])),
  limit: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 20 }), Type.Null()])),
  requestVersion: Type.Integer({ minimum: 0 }),
});

export function emergenceRoutes(service: EmergenceService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post(
      "/v1/knowledge/rooms/:id/emergence",
      {
        schema: {
          tags: ["knowledge"],
          params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }),
          body: EmergenceRequestBody,
        },
      },
      async (request, reply) => {
        try {
          return await service.project(request.params.id, request.body);
        } catch (error) {
          if (error instanceof EmergenceServiceError) {
            reply.code(error.statusCode);
            return { error: error.message };
          }
          throw error;
        }
      },
    );
  };
}
