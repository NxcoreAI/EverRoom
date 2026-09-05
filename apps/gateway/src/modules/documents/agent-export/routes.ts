import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AgentDocumentExportService } from "./service.js";
import { ExportServiceError } from "./service.js";

const providerSchema = Type.Union([Type.Literal("feishu"), Type.Literal("notion")]);
const modeSchema = Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("export_file")]);
const idText = { minLength: 1, maxLength: 256 } as const;

const targetSchema = Type.Object({
  remoteUrl: Type.Optional(Type.String({ maxLength: 2048 })),
  remoteDocumentId: Type.Optional(Type.String(idText)),
  parentUrl: Type.Optional(Type.String({ maxLength: 2048 })),
  parentId: Type.Optional(Type.String(idText)),
  writeScope: Type.Optional(Type.Union([Type.Literal("append"), Type.Literal("replace_document")])),
});

function errorPayload(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(error instanceof ExportServiceError)) return null;
  return {
    status: error.statusCode,
    body: { error: error.code, message: error.message, ...(error.details ?? {}) },
  };
}

export function agentDocumentExportRoutes(service: AgentDocumentExportService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post("/v1/agent/document-exports", {
      schema: {
        tags: ["agent-document-exports"],
        body: Type.Object({
          roomId: Type.String(idText),
          documentId: Type.String(idText),
          version: Type.Optional(Type.Integer({ minimum: 1 })),
          provider: providerSchema,
          mode: modeSchema,
          target: Type.Optional(Type.Union([targetSchema, Type.Null()])),
        }, { additionalProperties: false }),
      },
    }, async (request, reply) => {
      try {
        const { roomId, documentId, version, provider, mode, target } = request.body;
        // 异步驱动：立即返回 preparing，前端轮询看进度；Agent 工具走同步 runExport。
        const runId = await service.createRun({ roomId, documentId, version, provider, mode, target: target ?? null });
        void service.runFrom(runId);
        return service.getRun(runId);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.get("/v1/agent/document-exports", {
      schema: {
        tags: ["agent-document-exports"],
        querystring: Type.Object({
          documentId: Type.Optional(Type.String(idText)),
        }),
      },
    }, async (request) => {
      return { items: service.listRuns(request.query.documentId) };
    });

    app.get("/v1/agent/document-exports/:id", {
      schema: { tags: ["agent-document-exports"] },
    }, async (request, reply) => {
      try {
        return service.getRun((request.params as { id: string }).id);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.post("/v1/agent/document-exports/:id/confirm", {
      schema: { tags: ["agent-document-exports"] },
    }, async (request, reply) => {
      try {
        // 确认后后台执行写入，前端轮询状态（写入耗时可见 running 段）。
        return await service.confirm((request.params as { id: string }).id);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.post("/v1/agent/document-exports/:id/retry", {
      schema: { tags: ["agent-document-exports"] },
    }, async (request, reply) => {
      try {
        // 授权完成后恢复原任务：重新预检并继续（前端在授权成功事件后调用）。
        return await service.retry((request.params as { id: string }).id);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.post("/v1/agent/document-exports/search-targets", {
      schema: {
        tags: ["agent-document-exports"],
        body: Type.Object({
          provider: providerSchema,
          query: Type.String({ minLength: 1, maxLength: 120 }),
        }, { additionalProperties: false }),
      },
    }, async (request, reply) => {
      try {
        return { items: await service.searchUpdateTargets(request.body.provider, request.body.query) };
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.post("/v1/agent/document-exports/:id/cancel", {
      schema: { tags: ["agent-document-exports"] },
    }, async (request, reply) => {
      try {
        return service.cancelRun((request.params as { id: string }).id);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });
  };
}
