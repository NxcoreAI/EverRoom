import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { DocumentService } from "./service.js";
import { DocumentServiceError } from "./service.js";

const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) });
const TransactionParams = Type.Object({
  transactionId: Type.String({ minLength: 1, maxLength: 128 }),
});
const JsonDocument = Type.Object({ type: Type.Literal("doc") }, { additionalProperties: true });
const PatchStatus = Type.Union([
  Type.Literal("building"), Type.Literal("pending"), Type.Literal("applied"),
  Type.Literal("rejected"), Type.Literal("conflicted"), Type.Literal("aborted"), Type.Literal("expired"),
]);
const BlockReference = Type.Object({
  roomId: Type.String({ minLength: 1, maxLength: 128 }),
  documentId: Type.String({ minLength: 1, maxLength: 128 }),
  blockId: Type.String({ minLength: 1, maxLength: 128 }),
});

function errorPayload(error: DocumentServiceError) {
  return { error: error.code, message: error.message, ...error.details };
}

export function documentRoutes(service: DocumentService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/documents",
      {
        schema: {
          tags: ["documents"],
          querystring: Type.Object({
            roomId: Type.String({ minLength: 1, maxLength: 128 }),
            trashed: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
          }),
        },
      },
      async (request) => service.list(request.query.roomId, request.query.trashed === "true"),
    );

    app.get(
      "/v1/documents/:id",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => service.get(request.params.id)
        ?? reply.code(404).send({ error: "not_found", message: "Document not found" }),
    );

    app.get(
      "/v1/documents/:id/blocks",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        try {
          const document = service.get(request.params.id);
          if (!document) return reply.code(404).send({ error: "not_found", message: "Document not found" });
          return { documentId: document.id, roomId: document.roomId, version: document.version, blocks: service.listBlocks(document.id) };
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
            sourceRoomId: Type.String({ minLength: 1, maxLength: 128 }),
            references: Type.Array(BlockReference, { maxItems: 200 }),
          }),
        },
      },
      async (request, reply) => {
        try {
          return { resolutions: service.resolveBlockReferences(request.body) };
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.get(
      "/v1/document-patches",
      {
        schema: {
          tags: ["documents"],
          querystring: Type.Object({
            documentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            status: Type.Optional(PatchStatus),
          }),
        },
      },
      async (request) => service.listPatches(request.query.documentId, request.query.status),
    );

    app.get(
      "/v1/document-patches/:id",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => service.getPatch(request.params.id)
        ?? reply.code(404).send({ error: "patch_not_found", message: "Document patch not found" }),
    );

    app.post(
      "/v1/document-patches/:id/continuation/accept",
      {
        schema: {
          tags: ["documents"],
          params: IdParams,
          body: Type.Object({
            baseVersion: Type.Integer({ minimum: 0 }),
            blockId: Type.String({ minLength: 1, maxLength: 128 }),
          }),
        },
      },
      async (request, reply) => {
        try {
          return await service.acceptContinuationBlock(request.params.id, request.body);
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.post(
      "/v1/document-patches/:id/continuation/reject",
      {
        schema: {
          tags: ["documents"],
          params: IdParams,
          body: Type.Object({
            baseVersion: Type.Integer({ minimum: 0 }),
            blockId: Type.String({ minLength: 1, maxLength: 128 }),
          }),
        },
      },
      async (request, reply) => {
        try {
          return await service.rejectContinuationBlock(request.params.id, request.body);
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.post(
      "/v1/document-patches/:id/continuation/close",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        try {
          return await service.closeContinuation(request.params.id);
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.post(
      "/v1/document-patches/:id/apply",
      {
        schema: {
          tags: ["documents"],
          params: IdParams,
          body: Type.Object({
            baseVersion: Type.Integer({ minimum: 0 }),
            acceptedHunkIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1 }),
          }),
        },
      },
      async (request, reply) => {
        try {
          return await service.applyPatch(request.params.id, request.body);
        } catch (error) {
          if (error instanceof DocumentServiceError) return reply.code(error.statusCode).send(errorPayload(error));
          throw error;
        }
      },
    );

    app.post(
      "/v1/document-patches/:id/reject",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => {
        try {
          return await service.rejectPatch(request.params.id);
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
          querystring: Type.Object({ roomId: Type.String({ minLength: 1, maxLength: 128 }) }),
        },
      },
      async (request, reply) => {
        await service.emptyTrash(request.query.roomId);
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
            roomId: Type.String({ minLength: 1, maxLength: 128 }),
            title: Type.String({ minLength: 1, maxLength: 120 }),
            contentJson: JsonDocument,
          }),
        },
      },
      async (request, reply) => reply.code(201).send(await service.import(request.body)),
    );

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

    app.post(
      "/v1/document-transactions/:transactionId/ack",
      {
        schema: {
          tags: ["documents"],
          params: TransactionParams,
          body: Type.Object({
            sequence: Type.Integer({ minimum: 0 }),
            contentJson: JsonDocument,
          }),
        },
      },
      async (request, reply) => {
        try {
          await service.acknowledge(request.params.transactionId, request.body);
          return reply.code(204).send();
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send({ error: error.code, message: error.message });
          }
          throw error;
        }
      },
    );

    app.get(
      "/v1/documents/rooms/:id/stream",
      { websocket: true, schema: { tags: ["documents"], params: IdParams } },
      (socket, request) => {
        const unsubscribe = service.broker.subscribe(request.params.id, socket);
        socket.send(JSON.stringify({ type: "document.ready", protocol: 1, roomId: request.params.id }));
        for (const event of service.replayPending(request.params.id)) {
          socket.send(JSON.stringify({ type: "document.event", protocol: 1, event }));
        }
        socket.once("close", unsubscribe);
      },
    );
  };
}
