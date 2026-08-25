import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { DocumentUnderstandingService } from "./service.js";

const Params = Type.Object({ fileVersionId: Type.String({ minLength: 1, maxLength: 200 }) });

export function documentUnderstandingRoutes(
  service: DocumentUnderstandingService,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/document-understanding/:fileVersionId",
      {
        schema: {
          tags: ["document-understanding"],
          params: Params,
          response: {
            200: Type.Object({
              id: Type.String(),
              artifact: Type.Unknown(),
              markdown: Type.String(),
              deduplicated: Type.Boolean(),
              createdAt: Type.String(),
              updatedAt: Type.String(),
            }),
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => service.get(request.params.fileVersionId)
        ?? reply.code(404).send({ error: "document_artifact_not_found" }),
    );
  };
}
