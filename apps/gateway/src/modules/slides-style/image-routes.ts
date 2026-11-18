import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { SlideImageStore } from "./image-store.js";

const ImageHashParams = Type.Object({
  hash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
});

/**
 * 图片字节回源路由：按内容哈希取图（file_blobs / document-artifacts），只服务图片。
 * 路径保留 `/v1/materials/:hash`（桌面 `everroom-material://` 回源器与已存 deck 里的
 * 引用都钉在这个 URL 上）；内容寻址天然不可变，可长缓存；失败一律 404。
 */
export function slideImageRoutes(store: SlideImageStore): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/materials/:hash", {
      schema: {
        tags: ["slides"],
        params: ImageHashParams,
      },
    }, async (request, reply) => {
      const content = await store.readByHash(request.params.hash).catch(() => null);
      if (!content) return reply.code(404).send({ error: "material_not_found" });
      reply.header("content-type", content.mime);
      reply.header("cache-control", "public, max-age=31536000, immutable");
      return reply.send(content.buffer);
    });
  };
}
