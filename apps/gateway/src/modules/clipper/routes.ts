import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { ClipperService } from "./service.js";

const IdParams = Type.Object({
  captureId: Type.String({ minLength: 8, maxLength: 200 }),
});

const AssetParams = Type.Object({
  captureId: Type.String({ minLength: 8, maxLength: 200 }),
  assetId: Type.String({ minLength: 8, maxLength: 200 }),
});

const FileParams = Type.Object({ fileEntryId: Type.String({ minLength: 1, maxLength: 200 }) });
const AssetContentParams = Type.Object({ assetId: Type.String({ minLength: 8, maxLength: 200 }) });
const CaptureListQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});

const CaptureBody = Type.Object({
  captureId: Type.String({ minLength: 8, maxLength: 200 }),
  sourceUrl: Type.String({ minLength: 1, maxLength: 4_000 }),
  canonicalUrl: Type.String({ minLength: 1, maxLength: 4_000 }),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  author: Type.Optional(Type.String({ maxLength: 500 })),
  publishedAt: Type.Optional(Type.String({ maxLength: 100 })),
  capturedAt: Type.String({ minLength: 1, maxLength: 100 }),
  extractionMode: Type.Union([
    Type.Literal("selection"), Type.Literal("article"), Type.Literal("full-page"),
  ]),
  markdown: Type.String({ minLength: 1, maxLength: 6 * 1024 * 1024 }),
  extractorVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  assets: Type.Array(Type.Object({
    id: Type.String({ minLength: 8, maxLength: 200 }),
    referenceKey: Type.String({ minLength: 8, maxLength: 100 }),
    originalUrl: Type.String({ minLength: 1, maxLength: 4_000 }),
    altText: Type.Optional(Type.String({ maxLength: 1_000 })),
    width: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
    height: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
  }), { maxItems: 20 }),
});

export function clipperRoutes(service: ClipperService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/clipper/captures",
      {
        schema: {
          tags: ["clipper"],
          querystring: CaptureListQuery,
        },
      },
      async (request) => service.listCaptures(request.query.limit, request.query.offset),
    );

    app.post(
      "/v1/clipper/captures",
      { bodyLimit: 8 * 1024 * 1024, schema: { tags: ["clipper"], body: CaptureBody } },
      async (request, reply) => {
        try {
          return reply.code(202).send(await service.createCapture(request.body));
        } catch (error) {
          const code = error instanceof Error ? error.message : "clipper_capture_failed";
          return reply.code(400).send({ error: code });
        }
      },
    );

    app.put(
      "/v1/clipper/captures/:captureId/assets/:assetId",
      {
        bodyLimit: 3 * 1024 * 1024,
        schema: {
          tags: ["clipper"],
          params: AssetParams,
          body: Type.Object({ data: Type.String({ minLength: 4, maxLength: 2_850_000 }) }),
        },
      },
      async (request, reply) => {
        if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(request.body.data)) {
          return reply.code(400).send({ error: "clipper_asset_encoding_invalid" });
        }
        try {
          const asset = await service.storeAsset(
            request.params.captureId,
            request.params.assetId,
            Buffer.from(request.body.data, "base64"),
          );
          return reply.send(asset);
        } catch (error) {
          const code = error instanceof Error ? error.message : "clipper_asset_failed";
          return reply.code(code === "clipper_asset_not_found" ? 404 : 400).send({ error: code });
        }
      },
    );

    app.post(
      "/v1/clipper/captures/:captureId/finalize",
      {
        schema: {
          tags: ["clipper"],
          params: IdParams,
          body: Type.Object({ failures: Type.Array(Type.Object({
            assetId: Type.String({ minLength: 8, maxLength: 200 }),
            code: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          }), { maxItems: 20 }) }),
        },
      },
      async (request, reply) => {
        try {
          return service.finalizeCapture(request.params.captureId, request.body.failures);
        } catch (error) {
          const code = error instanceof Error ? error.message : "clipper_finalize_failed";
          return reply.code(code === "clipper_capture_not_found" ? 404 : 400).send({ error: code });
        }
      },
    );

    app.post(
      "/v1/clipper/captures/:captureId/retry",
      { schema: { tags: ["clipper"], params: IdParams } },
      async (request, reply) => {
        try {
          return service.retryCapture(request.params.captureId);
        } catch (error) {
          const code = error instanceof Error ? error.message : "clipper_retry_failed";
          return reply.code(code === "clipper_capture_not_found" ? 404 : 400).send({ error: code });
        }
      },
    );

    app.get(
      "/v1/clipper/files/:fileEntryId",
      { schema: { tags: ["clipper"], params: FileParams } },
      async (request, reply) => {
        const capture = service.latestForFile(request.params.fileEntryId);
        return capture ?? reply.code(404).send({ error: "clipper_capture_not_found" });
      },
    );

    app.get(
      "/v1/clipper/assets/:assetId/content",
      { schema: { tags: ["clipper"], params: AssetContentParams } },
      async (request, reply) => {
        const content = await service.assetContent(request.params.assetId);
        if (!content) return reply.code(404).send({ error: "clipper_asset_not_found" });
        reply.header("content-type", content.mime);
        reply.header("content-length", String(content.buffer.byteLength));
        reply.header("cache-control", "private, max-age=31536000, immutable");
        return reply.send(content.buffer);
      },
    );
  };
}
