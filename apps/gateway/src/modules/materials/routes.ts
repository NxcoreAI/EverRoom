import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { MaterialsService } from "./service.js";

const MaterialHashParams = Type.Object({
  hash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
});

/**
 * 本地素材取图路由：按内容哈希回源（file_blobs / document-artifacts），只服务图片字节。
 * 内容寻址天然不可变，可长缓存；取图失败一律 404，不回堆栈。
 */
export function materialsRoutes(materialsService: MaterialsService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/materials/:hash", {
      schema: {
        tags: ["materials"],
        params: MaterialHashParams,
      },
    }, async (request, reply) => {
      const content = await materialsService.readByHash(request.params.hash).catch(() => null);
      if (!content) return reply.code(404).send({ error: "material_not_found" });
      reply.header("content-type", content.mime);
      reply.header("cache-control", "public, max-age=31536000, immutable");
      return reply.send(content.buffer);
    });
  };
}