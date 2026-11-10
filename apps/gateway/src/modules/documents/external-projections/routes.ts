import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { DocumentServiceError } from "../errors.js";
import { roomScopeId } from "../room-scope.js";
import type { ExternalDocumentProjectionService } from "./service.js";

const ScopeId = Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]);
const Context = Type.Object({
  // 省略/null = 工作区级操作（P0-2d）；旧桌面仍可传真实 roomId。
  roomId: Type.Optional(ScopeId),
  sessionId: Type.String({ minLength: 1, maxLength: 128 }),
  runId: Type.String({ minLength: 1, maxLength: 128 }),
});

function errorPayload(error: DocumentServiceError) {
  return { error: error.code, message: error.message, ...error.details };
}

const SourceKind = Type.Union([Type.Literal("obsidian-vault"), Type.Literal("local-directory")]);

export function externalDocumentProjectionRoutes(
  service: ExternalDocumentProjectionService,
  authorizeContext?: (context: {
    capabilityId: string;
    agentSessionId: string;
    runId: string;
    roomId: string;
  }) => void,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.put("/v1/external-document-projections/:sourceKind/:sourceId/:resourceId", {
      schema: {
        tags: ["documents", "external-projections"],
        params: Type.Object({
          sourceKind: SourceKind,
          sourceId: Type.String({ minLength: 1, maxLength: 128 }),
          resourceId: Type.String({ minLength: 1, maxLength: 128 }),
        }),
        body: Type.Object({
          // 省略/null = 工作区作用域（service 归一为 scope sentinel 落库）。
          roomId: Type.Optional(ScopeId),
          relativePath: Type.String({ minLength: 1, maxLength: 2048 }),
          sourceHash: Type.String({ minLength: 16, maxLength: 128 }),
          title: Type.String({ minLength: 1, maxLength: 120 }),
          markdown: Type.String({ maxLength: 2 * 1024 * 1024 }),
        }),
      },
    }, async (request, reply) => {
      try {
        return await service.sync({
          sourceKind: request.params.sourceKind,
          sourceId: request.params.sourceId,
          resourceId: request.params.resourceId,
          ...request.body,
        });
      } catch (error) {
        if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
        throw error;
      }
    });

    app.delete("/v1/external-document-projections/:sourceKind/:sourceId", {
      schema: {
        tags: ["documents", "external-projections"],
        params: Type.Object({
          sourceKind: SourceKind,
          sourceId: Type.String({ minLength: 1, maxLength: 128 }),
        }),
        querystring: Type.Object({
          resourceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
      },
    }, async (request) => ({
      removed: await service.remove(request.params.sourceKind, request.params.sourceId, request.query.resourceId),
    }));

    app.delete("/v1/external-document-projections/documents/:documentId", {
      schema: {
        tags: ["documents", "external-projections"],
        params: Type.Object({ documentId: Type.String({ minLength: 1, maxLength: 128 }) }),
      },
    }, async (request, reply) => {
      try {
        await service.removeDocument(request.params.documentId);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
        throw error;
      }
    });

    app.post("/v1/external-document-patches/prepare", {
      schema: {
        tags: ["documents", "external-projections"],
        body: Type.Object({
          operationId: Type.String({ minLength: 1, maxLength: 128 }),
          command: Type.Object({
            commandId: Type.String({ minLength: 1, maxLength: 128 }),
            expectedRevision: Type.Integer({ minimum: 1 }),
            type: Type.String({ minLength: 1, maxLength: 128 }),
            payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            context: Context,
          }),
        }),
      },
    }, async (request, reply) => {
      try {
        const context = request.body.command.context;
        const normalizedContext = { ...context, roomId: context.roomId ?? null };
        const operation = service.getOperation(request.body.operationId);
        if (!operation) return reply.code(404).send({ error: "operation_not_found", message: "Document operation not found" });
        if (normalizedContext.roomId !== operation.roomId
          || context.sessionId !== operation.sessionId
          || context.runId !== operation.runId) {
          return reply.code(403).send({ error: "OPERATION_FORBIDDEN", message: "Operation belongs to another Agent run" });
        }
        authorizeContext?.({
          capabilityId: operation.capabilityId,
          agentSessionId: context.sessionId,
          runId: context.runId,
          roomId: roomScopeId(normalizedContext.roomId),
        });
        return await service.prepare({
          ...request.body,
          command: { ...request.body.command, context: normalizedContext },
        });
      } catch (error) {
        if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
        throw error;
      }
    });

    app.post("/v1/external-document-patches/complete", {
      schema: {
        tags: ["documents", "external-projections"],
        body: Type.Object({
          preparationId: Type.String({ minLength: 1, maxLength: 128 }),
          resultingSourceHash: Type.String({ minLength: 16, maxLength: 128 }),
          context: Context,
        }),
      },
    }, async (request, reply) => {
      try {
        const normalizedContext = { ...request.body.context, roomId: request.body.context.roomId ?? null };
        const preparationOperation = service.getOperationForPreparation(request.body.preparationId);
        if (!preparationOperation) {
          return reply.code(404).send({ error: "VAULT_PATCH_PREPARATION_NOT_FOUND", message: "Vault patch preparation not found" });
        }
        authorizeContext?.({
          capabilityId: preparationOperation.capabilityId,
          agentSessionId: normalizedContext.sessionId,
          runId: normalizedContext.runId,
          roomId: roomScopeId(normalizedContext.roomId),
        });
        return await service.complete({ ...request.body, context: normalizedContext });
      } catch (error) {
        if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
        throw error;
      }
    });
  };
}
