import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { BatchImportServiceError, type DocumentBatchImportService } from "./batch-service.js";

const providerSchema = Type.Union([Type.Literal("feishu"), Type.Literal("notion")]);
const idText = { minLength: 1, maxLength: 256 } as const;

function errorPayload(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(error instanceof BatchImportServiceError)) return null;
  return {
    status: error.statusCode,
    body: { error: error.code, message: error.message },
  };
}

/** 连接器页批量导入（异步批：创建即返回，轮询进度；与单文档导入路由分文件，降低装配冲突面）。 */
export function documentImportBatchRoutes(service: DocumentBatchImportService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post("/v1/document-import/batch", {
      schema: {
        tags: ["document-import"],
        body: Type.Object({
          provider: providerSchema,
          connectionName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          remoteDocumentIds: Type.Array(Type.String(idText), { minItems: 1, maxItems: 50 }),
          mode: Type.Union([Type.Literal("room"), Type.Literal("auto")]),
          roomId: Type.Optional(Type.String(idText)),
        }, { additionalProperties: false }),
      },
    }, async (request, reply) => {
      try {
        return await service.createBatch({
          provider: request.body.provider,
          ...(request.body.connectionName ? { connectionName: request.body.connectionName } : {}),
          remoteDocumentIds: request.body.remoteDocumentIds,
          mode: request.body.mode,
          ...(request.body.roomId ? { roomId: request.body.roomId } : {}),
        });
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.get("/v1/document-import/batch/:id", {
      schema: { tags: ["document-import"] },
    }, async (request, reply) => {
      try {
        return service.getBatch((request.params as { id: string }).id);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.post("/v1/document-import/batch/:id/cancel", {
      schema: { tags: ["document-import"] },
    }, async (request, reply) => {
      try {
        return service.cancelBatch((request.params as { id: string }).id);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });
  };
}
