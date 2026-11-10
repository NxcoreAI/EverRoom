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

/** 连接器页批量导入（异步批：创建即返回，轮询进度；与单文档导入路由分文件，降低装配冲突面）。
 *
 * Phase 2i-3：批量导入只剩「导入工作区文档库」一种行为。`mode` 的两个历史取值
 * `'room'`/`'auto'` 语义相同（DTO 形状冻结，见 `DocumentImportBatchMode`）；batch
 * body 里的 `roomId` 只为兼容旧版桌面构建保留（Room 已删除，服务端忽略）。
 *
 * Phase 2i-4：「是否已导入」预检改名为 `existing-in-workspace`，判定口径本来就是
 * 工作区文稿（`importedInWorkspace`），body 里不再接受房间维度入参。 */
export function documentImportBatchRoutes(
  service: DocumentBatchImportService,
  imports?: { importedInWorkspace(provider: "feishu" | "notion", remoteDocumentIds: string[]): string[] },
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post("/v1/document-import/existing-in-workspace", {
      schema: {
        tags: ["document-import"],
        body: Type.Object({
          provider: providerSchema,
          remoteDocumentIds: Type.Array(Type.String(idText), { minItems: 1, maxItems: 50 }),
        }, { additionalProperties: false }),
      },
    }, async (request, reply) => {
      try {
        if (!imports) throw new BatchImportServiceError("NOT_FOUND", "导入服务不可用", 404);
        return {
          provider: request.body.provider,
          existingRemoteIds: imports.importedInWorkspace(
            request.body.provider,
            request.body.remoteDocumentIds,
          ),
        };
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });
    app.post("/v1/document-import/batch", {
      schema: {
        tags: ["document-import"],
        body: Type.Object({
          provider: providerSchema,
          connectionName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          remoteDocumentIds: Type.Array(Type.String(idText), { minItems: 1, maxItems: 50 }),
          // 兼容旧版桌面构建：'room' 与 'auto' 语义相同——一律导入工作区文档库。
          mode: Type.Union([Type.Literal("room"), Type.Literal("auto")]),
          // 兼容字段：Room 维度已删，显式目标不再有意义，服务端忽略。
          roomId: Type.Optional(Type.String(idText)),
          forceNew: Type.Optional(Type.Boolean()),
        }, { additionalProperties: false }),
      },
    }, async (request, reply) => {
      try {
        return await service.createBatch({
          provider: request.body.provider,
          ...(request.body.connectionName ? { connectionName: request.body.connectionName } : {}),
          remoteDocumentIds: request.body.remoteDocumentIds,
          mode: request.body.mode,
          ...(request.body.forceNew !== undefined ? { forceNew: request.body.forceNew } : {}),
        });
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.get("/v1/document-import/batches/active", {
      schema: {
        tags: ["document-import"],
        querystring: Type.Object({
          provider: providerSchema,
          connectionName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }, { additionalProperties: false }),
      },
    }, async (request) => {
      const query = request.query as { provider: "feishu" | "notion"; connectionName?: string };
      return service.getActiveBatch(query.provider, query.connectionName);
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
