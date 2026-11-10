import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { SlidesPageImageSessionStore } from "../subagents/slides-page-images-store.js";
import { pageImagesReviewPayload } from "../subagents/slides-page-images-stage.js";

const PageImagesParams = Type.Object({
  documentId: Type.String({ minLength: 1, maxLength: 128 }),
});

/**
 * 配图过目卡轮询路由：后台逐张生成期间，前端按 draftDocumentId 拉最新会话快照
 * （与广播载荷同构）。工具调用的进度通道在终态后被渲染层丢弃，轮询是唯一刷新途径。
 */
export function slidesPageImagesRoutes(
  sessions: SlidesPageImageSessionStore,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/slides/page-images/:documentId", {
      schema: {
        tags: ["slides"],
        params: PageImagesParams,
      },
    }, async (request, reply) => {
      const rows = sessions.listByDocument(request.params.documentId);
      if (rows.length === 0) return reply.code(404).send({ error: "page_images_session_not_found" });
      return reply.send(pageImagesReviewPayload(rows[0]!));
    });
  };
}
