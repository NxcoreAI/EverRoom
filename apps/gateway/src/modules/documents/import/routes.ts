import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { ExternalDocumentProvider } from "@nxcore/agent-contract";
import { ImportServiceError, type DocumentImportService } from "./service.js";

const providerSchema = Type.Union([Type.Literal("feishu"), Type.Literal("notion")]);
const idText = { minLength: 1, maxLength: 256 } as const;

function errorPayload(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(error instanceof ImportServiceError)) return null;
  return {
    status: error.statusCode,
    body: { error: error.code, message: error.message, ...(error.details ?? {}) },
  };
}

export function documentImportRoutes(service: DocumentImportService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post("/v1/document-import/search", {
      schema: {
        tags: ["document-import"],
        body: Type.Object({
          provider: providerSchema,
          query: Type.String({ minLength: 1, maxLength: 120 }),
        }, { additionalProperties: false }),
      },
    }, async (request, reply) => {
      try {
        return await service.search(request.body.provider, request.body.query);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.post("/v1/document-import/preview", {
      schema: {
        tags: ["document-import"],
        body: Type.Object({
          provider: providerSchema,
          remoteDocumentId: Type.String(idText),
        }, { additionalProperties: false }),
      },
    }, async (request, reply) => {
      try {
        return await service.preview(request.body.provider, request.body.remoteDocumentId);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.post("/v1/document-import/runs", {
      schema: {
        tags: ["document-import"],
        body: Type.Object({
          runId: Type.String(idText),
          roomId: Type.String(idText),
          targetDocumentId: Type.Optional(Type.String(idText)),
        }, { additionalProperties: false }),
      },
    }, async (request, reply) => {
      try {
        return await service.commitToRoom(request.body);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.get("/v1/document-import/runs/:id", {
      schema: { tags: ["document-import"] },
    }, async (request, reply) => {
      try {
        return service.getRun((request.params as { id: string }).id);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.post("/v1/document-import/runs/:id/cancel", {
      schema: { tags: ["document-import"] },
    }, async (request, reply) => {
      try {
        return service.cancelRun((request.params as { id: string }).id);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.post("/v1/rooms/:roomId/documents/:documentId/check-external-update", {
      schema: {
        tags: ["document-import"],
        params: Type.Object({
          roomId: Type.String(idText),
          documentId: Type.String(idText),
        }),
      },
    }, async (request, reply) => {
      const { roomId, documentId } = request.params;
      try {
        return await service.checkExternalUpdate(roomId, documentId);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.get("/v1/rooms/:roomId/documents/:documentId/import-history", {
      schema: {
        tags: ["document-import"],
        params: Type.Object({
          roomId: Type.String(idText),
          documentId: Type.String(idText),
        }),
      },
    }, async (request, reply) => {
      const { roomId, documentId } = request.params;
      try {
        return await service.importHistory(roomId, documentId);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    app.post("/v1/document-import/room-imports/:id/apply", {
      schema: { tags: ["document-import"] },
    }, async (request, reply) => {
      try {
        return await service.applyCandidate((request.params as { id: string }).id);
      } catch (error) {
        const mapped = errorPayload(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });
  };
}

export type { ExternalDocumentProvider };
