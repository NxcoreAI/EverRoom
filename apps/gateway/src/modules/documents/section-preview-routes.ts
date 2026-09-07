import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import { DocumentServiceError } from "./errors.js";
import type { DocumentService } from "./service.js";

const idText = { minLength: 1, maxLength: 128 } as const;

/**
 * 章节刻度线 hover 的 AI 章节预览：单端点（无 GET——正文与 hash 随请求
 * 携带，持久缓存命中在同一 POST 里廉价返回）。生成只写
 * document_section_previews 表，不影响正文与 version。
 */
export function documentSectionPreviewRoutes(
  service: DocumentService,
  runtime: AgentRuntime | null,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post("/v1/documents/:id/section-preview", {
      schema: {
        tags: ["documents"],
        params: Type.Object({ id: Type.String(idText) }),
        body: Type.Object({
          blockId: Type.String(idText),
          headingText: Type.String({ minLength: 1, maxLength: 500 }),
          sectionMarkdown: Type.String({ minLength: 0, maxLength: 20_000 }),
          contentHash: Type.String({ minLength: 8, maxLength: 128 }),
        }, { additionalProperties: false }),
      },
    }, async (request, reply) => {
      try {
        return await service.getOrGenerateSectionPreview(
          request.params.id,
          request.body,
          runtime,
        );
      } catch (error) {
        if (error instanceof DocumentServiceError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message, ...(error.details ?? {}) });
        }
        throw error;
      }
    });
  };
}
