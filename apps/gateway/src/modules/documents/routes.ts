import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { DocumentService } from "./service.js";
import { DocumentServiceError } from "./service.js";

const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) });
const TransactionParams = Type.Object({
  transactionId: Type.String({ minLength: 1, maxLength: 128 }),
});
const JsonDocument = Type.Object({ type: Type.Literal("doc") }, { additionalProperties: true });

export function documentRoutes(service: DocumentService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/documents",
      {
        schema: {
          tags: ["documents"],
          querystring: Type.Object({ roomId: Type.String({ minLength: 1, maxLength: 128 }) }),
        },
      },
      async (request) => service.list(request.query.roomId),
    );

    app.get(
      "/v1/documents/:id",
      { schema: { tags: ["documents"], params: IdParams } },
      async (request, reply) => service.get(request.params.id)
        ?? reply.code(404).send({ error: "not_found", message: "Document not found" }),
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
            contentJson: JsonDocument,
          }),
        },
      },
      async (request, reply) => {
        try {
          return await service.save(request.params.id, request.body);
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send({ error: error.code, message: error.message });
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
