import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import multipart from "@fastify/multipart";
import { Type } from "@sinclair/typebox";
import type { ThesisFormatService } from "./service.js";

const RoomParams = Type.Object({
  roomId: Type.String({ minLength: 1, maxLength: 128 }),
});

const CardParams = Type.Object({
  roomId: Type.String({ minLength: 1, maxLength: 128 }),
  cardId: Type.String({ minLength: 1, maxLength: 64 }),
});

const ParseBody = Type.Object({
  fileEntryId: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });

const ReformatBody = Type.Object({
  fileEntryId: Type.String({ minLength: 1, maxLength: 200 }),
  cardId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
}, { additionalProperties: false });

const CardDto = Type.Object({
  id: Type.String(),
  sourceName: Type.String(),
  sourceFileEntryId: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.String(),
  card: Type.Unknown(),
});

/**
 * 论文格式管线路由：模版解析（库内文件 / multipart 直传，zip 不进文件库）、
 * 格式卡列表/删除与一键装订。装订是长任务（子代理映射 + 桌面渲染 + 入库），HTTP 同步等待。
 */
export function thesisFormatRoutes(service: ThesisFormatService): FastifyPluginAsyncTypebox {
  return async (app) => {
    await app.register(multipart, {
      attachFieldsToBody: false,
      limits: { fileSize: 80 * 1024 * 1024, files: 1 },
    });

    app.get("/v1/thesis-format/rooms/:roomId/cards", {
      schema: {
        tags: ["thesis-format"],
        params: RoomParams,
        response: {
          200: Type.Array(CardDto),
        },
      },
    }, async (request) => {
      return service.cardStore().list(request.params.roomId).map((row) => ({
        id: row.id,
        sourceName: row.sourceName,
        sourceFileEntryId: row.sourceFileEntryId,
        updatedAt: row.updatedAt.toISOString(),
        card: row.card,
      }));
    });

    app.delete("/v1/thesis-format/rooms/:roomId/cards/:cardId", {
      schema: {
        tags: ["thesis-format"],
        params: CardParams,
        response: {
          200: Type.Object({ removed: Type.Boolean() }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    }, async (request, reply) => {
      const removed = service.removeCard(request.params.roomId, request.params.cardId);
      if (!removed) return reply.code(404).send({ error: "thesis_format_card_not_found" });
      return { removed: true };
    });

    app.post("/v1/thesis-format/rooms/:roomId/parse", {
      schema: {
        tags: ["thesis-format"],
        params: RoomParams,
        body: ParseBody,
        response: {
          200: Type.Object({
            cardId: Type.String(),
            sourceName: Type.String(),
            card: Type.Unknown(),
          }),
          400: Type.Object({ error: Type.String() }),
        },
      },
    }, async (request, reply) => {
      try {
        const result = await service.parseFromLibrary(request.params.roomId, request.body.fileEntryId);
        return reply.send({ cardId: result.cardId, sourceName: result.sourceName, card: result.card });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "thesis_parse_failed" });
      }
    });

    app.post("/v1/thesis-format/rooms/:roomId/parse-upload", {
      schema: { tags: ["thesis-format"], params: RoomParams },
      bodyLimit: 80 * 1024 * 1024,
    }, async (request, reply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "file_part_required" });
      const name = file.filename || "模版.zip";
      const bytes = await file.toBuffer();
      if (bytes.length === 0) return reply.code(400).send({ error: "file_empty" });
      try {
        const result = await service.parseFromUpload(request.params.roomId, bytes, name);
        return reply.send({ cardId: result.cardId, sourceName: result.sourceName, card: result.card });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "thesis_parse_failed" });
      }
    });

    app.post("/v1/thesis-format/rooms/:roomId/reformat", {
      schema: {
        tags: ["thesis-format"],
        params: RoomParams,
        body: ReformatBody,
        response: {
          200: Type.Object({
            fileEntryId: Type.String(),
            originalName: Type.String(),
          }),
          400: Type.Object({ error: Type.String() }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    }, async (request, reply) => {
      try {
        const result = await service.reformat(
          request.params.roomId,
          request.body.fileEntryId,
          request.body.cardId,
        );
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "thesis_reformat_failed";
        const code = message === "thesis_format_card_not_found" ? 404 : 400;
        return reply.code(code).send({ error: message });
      }
    });
  };
}
