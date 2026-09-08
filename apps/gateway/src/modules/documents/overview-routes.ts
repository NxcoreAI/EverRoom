import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import { DocumentServiceError } from "./errors.js";
import type { DocumentService } from "./service.js";

const idText = { minLength: 1, maxLength: 128 } as const;

/**
 * 文档速览：GET 读 overview 3 列 + 空短判定（aiAvailable 由本层注入，
 * 前端据此跳过注定 4xx 的自动生成）；POST 同步生成（两次尝试内完成，
 * 30s 级超时）。生成只写速览列，不影响正文与 version。
 */
export function documentOverviewRoutes(
  service: DocumentService,
  runtime: AgentRuntime | null,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/documents/:id/overview", {
      schema: {
        tags: ["documents"],
        params: Type.Object({ id: Type.String(idText) }),
      },
    }, async (request, reply) => {
      try {
        return { ...service.getDocumentOverview(request.params.id), aiAvailable: Boolean(runtime) };
      } catch (error) {
        if (error instanceof DocumentServiceError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message, ...(error.details ?? {}) });
        }
        throw error;
      }
    });

    app.post("/v1/documents/:id/overview/generate", {
      schema: {
        tags: ["documents"],
        params: Type.Object({ id: Type.String(idText) }),
      },
    }, async (request, reply) => {
      try {
        return await service.generateDocumentOverview(request.params.id, runtime);
      } catch (error) {
        if (error instanceof DocumentServiceError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message, ...(error.details ?? {}) });
        }
        throw error;
      }
    });
  };
}
