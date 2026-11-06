import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { WORKSPACE_DOCUMENT_CHANNEL } from "@nxcore/agent-contract";
import { agentDocumentMarkdown } from "./agent-markdown.js";
import { documentBodyContent } from "./content-model.js";
import { DocumentServiceError, type DocumentService } from "./service.js";
import type { DocumentIndexBackfillReadTrigger } from "./index-backfill/read-trigger.js";
const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) });
const JsonDocument = Type.Object({ type: Type.Literal("doc") }, { additionalProperties: true });
const ScopeId = Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]));
const BlockReference = Type.Object({
  // 省略/null = 工作区作用域（旧桌面仍可带真实 roomId）。
  roomId: ScopeId,
  documentId: Type.String({ minLength: 1, maxLength: 128 }), blockId: Type.String({ minLength: 1, maxLength: 128 }),
});
function errorPayload(error: DocumentServiceError) {
  return { error: error.code, message: error.message, ...error.details };
}

export function documentRoutes(
  service: DocumentService,
  summaryRuntime?: () => import("@nxcore/agent-runtime").AgentRuntime | null,
  indexBackfillReadTrigger?: DocumentIndexBackfillReadTrigger | null,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    // 工作区级文稿库（Phase 2i 起不再有 Room 分区，roomId 查询参数已删除）。
    app.get(
      "/v1/documents",
      {
        schema: {
          tags: ["documents"],
          querystring: Type.Object({
            trashed: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
            origin: Type.Optional(Type.Union([Type.Literal("native"), Type.Literal("import")])),
          }),
        },
      },
      async (request) => service.list(
        request.query.trashed === "true",
        request.query.origin,
      ),
    );

    app.get(
      "/v1/documents/:id",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        const document = service.get(request.params.id);
        if (!document) return reply.code(404).send({ error: "not_found", message: "Document not found" });
        indexBackfillReadTrigger?.trigger(document);
        return document;
      },
    );

    // 文档正文的 Markdown 序列化（与 external-projections 写回 Vault 用同一个序列化器，
    // 保证「编辑器保存 → 写回笔记文件 → 文件同步回文档」内容一致、不产生额外版本抖动）。
    app.get(
      "/v1/documents/:id/markdown",
      {
        schema: {
          tags: ["documents"],
          params: IdParams,
          response: {
            200: Type.Object({ documentId: Type.String(), markdown: Type.String() }),
            404: Type.Object({ error: Type.String(), message: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const document = service.get(request.params.id);
        if (!document) return reply.code(404).send({ error: "not_found", message: "Document not found" });
        return {
          documentId: document.id,
          markdown: agentDocumentMarkdown.serialize(documentBodyContent(document.contentJson)),
        };
      },
    );

    app.get(
      "/v1/documents/:id/blocks",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        try {
          const document = service.get(request.params.id);
          if (!document) return reply.code(404).send({ error: "not_found", message: "Document not found" });
          indexBackfillReadTrigger?.trigger(document);
          return {
            documentId: document.id,
            roomId: document.roomId,
            version: document.version,
            blocks: service.listBlocks(document.id),
          };
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.get(
      "/v1/documents/:id/backlinks",
      {
        schema: {
          tags: ["documents"],
          params: IdParams,
          querystring: Type.Object({
            blockId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          }),
        },
      },
      async (request, reply) => {
        try {
          return {
            documentId: request.params.id,
            blockId: request.query.blockId ?? null,
            backlinks: service.listBlockBacklinks(request.params.id, request.query.blockId),
          };
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.get(
      "/v1/documents/:id/versions",
      {
        schema: {
          tags: ["documents"],
          params: IdParams,
          querystring: Type.Object({
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
            beforeVersion: Type.Optional(Type.Integer({ minimum: 1 })),
          }),
        },
      },
      async (request, reply) => {
        try {
          return service.listVersions(request.params.id, request.query);
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.get(
      "/v1/documents/:id/versions/:version/change-summary",
      {
        schema: {
          tags: ["documents"],
          params: Type.Object({
            id: Type.String({ minLength: 1, maxLength: 128 }),
            version: Type.Integer({ minimum: 1 }),
          }),
        },
      },
      async (request, reply) => {
        try {
          return await service.versionChangeSummary(request.params.id, request.params.version, summaryRuntime?.() ?? null);
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send({ error: error.code, message: error.message, ...(error.details ?? {}) });
          }
          throw error;
        }
      },
    );

    app.get(
      "/v1/documents/:id/versions/:version",
      {
        schema: {
          tags: ["documents"],
          params: Type.Object({
            id: Type.String({ minLength: 1, maxLength: 128 }),
            version: Type.Integer({ minimum: 1 }),
          }),
        },
      },
      async (request, reply) => {
        try {
          const snapshot = service.getVersionSnapshot(request.params.id, request.params.version);
          return snapshot ?? reply.code(404).send({ error: "VERSION_NOT_FOUND", message: "Document version not found" });
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.get(
      "/v1/documents/:id/diff",
      {
        schema: {
          tags: ["documents"],
          params: IdParams,
          querystring: Type.Object({
            toVersion: Type.Integer({ minimum: 1 }),
            fromVersion: Type.Optional(Type.Integer({ minimum: 1 })),
          }),
        },
      },
      async (request, reply) => {
        try {
          const result = service.diff(
            request.params.id,
            request.query.fromVersion ?? null,
            request.query.toVersion,
          );
          return result ?? reply.code(404).send({ error: "VERSION_NOT_FOUND", message: "Document version not found" });
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.post(
      "/v1/documents/:id/history/backfill/retry",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        try {
          service.retryYjsHistoryBackfill(request.params.id);
          return { queued: true, documentId: request.params.id };
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.post(
      "/v1/documents/:id/versions/:version/restore",
      {
        schema: {
          tags: ["documents"],
          params: Type.Object({
            id: Type.String({ minLength: 1, maxLength: 128 }),
            version: Type.Integer({ minimum: 1 }),
          }),
          body: Type.Object({ baseVersion: Type.Integer({ minimum: 0 }) }),
        },
      },
      async (request, reply) => {
        try {
          return await service.restoreVersion(
            request.params.id,
            request.params.version,
            request.body.baseVersion,
          );
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.post(
      "/v1/document-blocks/resolve",
      {
        schema: {
          tags: ["documents"],
          body: Type.Object({
            // 省略/null = 工作区作用域（旧桌面仍可带真实 roomId）。
            sourceRoomId: ScopeId,
            references: Type.Array(BlockReference, { maxItems: 200 }),
          }),
        },
      },
      async (request, reply) => {
        try {
          // 作用域归一：块引用管线仍以「非空 scope 字符串」为分区键，工作区落频道 sentinel。
          return {
            resolutions: service.resolveBlockReferences({
              sourceRoomId: request.body.sourceRoomId ?? WORKSPACE_DOCUMENT_CHANNEL,
              references: request.body.references.map((reference) => ({
                ...reference,
                roomId: reference.roomId ?? WORKSPACE_DOCUMENT_CHANNEL,
              })),
            }),
          };
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.delete(
      "/v1/documents/trash",
      {
        schema: {
          tags: ["documents"],
          // 清空整个工作区回收站（Phase 2i 起 Room 过滤维度已删除）。
        },
      },
      async (_request, reply) => {
        await service.emptyTrash();
        return reply.code(204).send();
      },
    );

    app.post(
      "/v1/documents/import",
      {
        schema: {
          tags: ["documents"],
          body: Type.Object({
            id: Type.String({ minLength: 1, maxLength: 128 }),
            // 省略 = 工作区级文稿（不归属任何 Room，P0-2）。
            roomId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()])),
            title: Type.String({ minLength: 1, maxLength: 120 }),
            contentJson: JsonDocument,
            origin: Type.Optional(Type.Union([Type.Literal("native"), Type.Literal("import")])),
          }),
        },
      },
      async (request, reply) =>
        reply.code(201).send(await service.import({ ...request.body, roomId: request.body.roomId ?? null })),
    );

;

    app.put(
      "/v1/documents/:id",
      {
        schema: {
          tags: ["documents"],
          params: IdParams,
          body: Type.Object({
            baseVersion: Type.Integer({ minimum: 0 }),
            title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            contentJson: JsonDocument,
          }),
        },
      },
      async (request, reply) => {
        try {
          return await service.save(request.params.id, request.body);
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send(errorPayload(error));
          }
          throw error;
        }
      },
    );

    app.delete(
      "/v1/documents/:id",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        try {
          await service.delete(request.params.id);
          return reply.code(204).send();
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send({ error: error.code, message: error.message });
          }
          throw error;
        }
      },
    );

    app.post(
      "/v1/documents/:id/restore",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        try {
          return await service.restore(request.params.id);
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send({ error: error.code, message: error.message });
          }
          throw error;
        }
      },
    );

    app.delete(
      "/v1/documents/:id/permanent",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        try {
          await service.deletePermanently(request.params.id);
          return reply.code(204).send();
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send({ error: error.code, message: error.message });
          }
          throw error;
        }
      },
    );

    // 文档事件 WS：**工作区文档频道**（不是 Room 资源，路径里的 `rooms` 段是冻结的
    // 历史命名，改 URL 会断开桌面的旧订阅）。桌面 document-gateway-bridge 以
    // WORKSPACE_DOCUMENT_CHANNEL 作为 `:id` 订阅，Phase 2i 起它就是工作区频道本身。
    app.get(
      "/v1/documents/rooms/:id/stream",
      { websocket: true, schema: { tags: ["documents"], params: IdParams } },
      (socket, request) => {
        const unsubscribe = service.broker.subscribe(request.params.id, socket);
        socket.send(JSON.stringify({ type: "document.ready", protocol: 1, roomId: request.params.id }));
        socket.once("close", unsubscribe);
      },
    );
  };
}
