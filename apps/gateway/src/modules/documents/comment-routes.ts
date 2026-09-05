import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { DocumentServiceError } from "./errors.js";
import type { DocumentCommentService } from "./comments.js";

const idText = { minLength: 1, maxLength: 128 } as const;

export function documentCommentRoutes(service: DocumentCommentService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/documents/:id/comments", {
      schema: {
        tags: ["documents"],
        params: Type.Object({ id: Type.String(idText) }),
      },
    }, async (request) => {
      return { items: service.list(request.params.id) };
    });

    app.post("/v1/documents/:id/comments", {
      schema: {
        tags: ["documents"],
        params: Type.Object({ id: Type.String(idText) }),
        body: Type.Object({
          body: Type.String({ minLength: 1, maxLength: 4000 }),
          parentId: Type.Optional(Type.Union([Type.String(idText), Type.Null()])),
          blockId: Type.Optional(Type.Union([Type.String(idText), Type.Null()])),
          quotedText: Type.Optional(Type.String({ maxLength: 500 })),
        }, { additionalProperties: false }),
      },
    }, async (request, reply) => {
      const { id } = request.params;
      const { body, parentId, blockId, quotedText } = request.body;
      try {
        return service.create({ documentId: id, body, parentId: parentId ?? null, blockId: blockId ?? null, quotedText: quotedText ?? null });
      } catch (error) {
        if (error instanceof DocumentServiceError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message, ...(error.details ?? {}) });
        }
        throw error;
      }
    });

    app.post("/v1/documents/:id/comments/:commentId/resolve", {
      schema: {
        tags: ["documents"],
        params: Type.Object({ id: Type.String(idText), commentId: Type.String(idText) }),
        body: Type.Object({ resolved: Type.Boolean() }, { additionalProperties: false }),
      },
    }, async (request, reply) => {
      const { id, commentId } = request.params;
      try {
        return service.resolve(id, commentId, request.body.resolved);
      } catch (error) {
        if (error instanceof DocumentServiceError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    });

    app.delete("/v1/documents/:id/comments/:commentId", {
      schema: {
        tags: ["documents"],
        params: Type.Object({ id: Type.String(idText), commentId: Type.String(idText) }),
      },
    }, async (request, reply) => {
      const { id, commentId } = request.params;
      try {
        service.delete(id, commentId);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof DocumentServiceError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    });
  };
}
