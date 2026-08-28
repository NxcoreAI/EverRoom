import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { DocumentServiceError } from "../errors.js";
import type { ExternalDocumentProjectionService } from "./service.js";

const Context = Type.Object({
  roomId: Type.String({ minLength: 1, maxLength: 128 }),
  sessionId: Type.String({ minLength: 1, maxLength: 128 }),
  runId: Type.String({ minLength: 1, maxLength: 128 }),
});

function errorPayload(error: DocumentServiceError) {
  return { error: error.code, message: error.message, ...error.details };
}

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
    app.put("/v1/external-document-projections/obsidian-vault/:sourceId/:resourceId", {
      schema: {
        tags: ["documents", "external-projections"],
        params: Type.Object({
          sourceId: Type.String({ minLength: 1, maxLength: 128 }),
          resourceId: Type.String({ minLength: 1, maxLength: 128 }),
        }),
        body: Type.Object({
          roomId: Type.String({ minLength: 1, maxLength: 128 }),
          relativePath: Type.String({ minLength: 1, maxLength: 2048 }),
          sourceHash: Type.String({ minLength: 16, maxLength: 128 }),
          title: Type.String({ minLength: 1, maxLength: 120 }),
          markdown: Type.String({ maxLength: 2 * 1024 * 1024 }),
        }),
      },
    }, async (request, reply) => {
      try {
        return await service.sync({
          sourceKind: "obsidian-vault",
          sourceId: request.params.sourceId,
          resourceId: request.params.resourceId,
          ...request.body,
        });
      } catch (error) {
        if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
        throw error;
      }
    });

    app.delete("/v1/external-document-projections/obsidian-vault/:sourceId", {
      schema: {
        tags: ["documents", "external-projections"],
        params: Type.Object({ sourceId: Type.String({ minLength: 1, maxLength: 128 }) }),
        querystring: Type.Object({
          resourceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
      },
    }, async (request) => ({
      removed: await service.remove("obsidian-vault", request.params.sourceId, request.query.resourceId),
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
        const operation = service.getOperation(request.body.operationId);
        if (!operation) return reply.code(404).send({ error: "operation_not_found", message: "Document operation not found" });
        if (context.roomId !== operation.roomId || context.sessionId !== operation.sessionId || context.runId !== operation.runId) {
          return reply.code(403).send({ error: "OPERATION_FORBIDDEN", message: "Operation belongs to another Agent run" });
        }
        authorizeContext?.({
          capabilityId: operation.capabilityId,
          agentSessionId: context.sessionId,
          runId: context.runId,
          roomId: context.roomId,
        });
        return await service.prepare(request.body);
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
        const preparationOperation = service.getOperationForPreparation(request.body.preparationId);
        if (!preparationOperation) {
          return reply.code(404).send({ error: "VAULT_PATCH_PREPARATION_NOT_FOUND", message: "Vault patch preparation not found" });
        }
        authorizeContext?.({
          capabilityId: preparationOperation.capabilityId,
          agentSessionId: request.body.context.sessionId,
          runId: request.body.context.runId,
          roomId: request.body.context.roomId,
        });
        return await service.complete(request.body);
      } catch (error) {
        if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
        throw error;
      }
    });
  };
}
