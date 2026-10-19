import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { ScreenMemoryService } from "./service.js";

const KeyframeInput = Type.Object({
  capturedAt: Type.String({ format: "date-time" }),
  imagePath: Type.String({ minLength: 1, maxLength: 2_048 }),
  imageBytes: Type.Integer({ minimum: 0 }),
  perceptualHash: Type.String({ minLength: 1, maxLength: 64 }),
  width: Type.Integer({ minimum: 1 }),
  height: Type.Integer({ minimum: 1 }),
  lineCount: Type.Integer({ minimum: 0 }),
  elapsedMs: Type.Number({ minimum: 0 }),
});

const IntervalInput = Type.Object({
  id: Type.Optional(Type.String({ minLength: 8, maxLength: 64 })),
  bundleId: Type.String({ minLength: 1, maxLength: 256 }),
  appName: Type.String({ minLength: 1, maxLength: 256 }),
  windowTitle: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
  title: Type.String({ minLength: 1, maxLength: 512 }),
  startedAt: Type.String({ format: "date-time" }),
  endedAt: Type.String({ format: "date-time" }),
  endReason: Type.Union([
    Type.Literal("app-switch"),
    Type.Literal("lock"),
    Type.Literal("suspend"),
    Type.Literal("idle"),
    Type.Literal("out-of-scope"),
    Type.Literal("paused"),
    Type.Literal("stopped"),
  ]),
  textLines: Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 5_000 }),
  textBlocks: Type.Optional(Type.Array(Type.String({ maxLength: 20_000 }), { maxItems: 1_000 })),
  keyframes: Type.Array(KeyframeInput, { maxItems: 200 }),
});

const ListQuery = Type.Object({
  from: Type.Optional(Type.String({ format: "date-time" })),
  to: Type.Optional(Type.String({ format: "date-time" })),
  bundleId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  summaryStatus: Type.Optional(Type.Union([
    Type.Literal("pending"), Type.Literal("ready"), Type.Literal("waiting"), Type.Literal("failed"),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});

const SearchQuery = Type.Object({
  q: Type.String({ minLength: 1, maxLength: 200 }),
  bundleId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  from: Type.Optional(Type.String({ format: "date-time" })),
  to: Type.Optional(Type.String({ format: "date-time" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
});

function dateOf(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_date");
  return date;
}

export function screenMemoryRoutes(service: ScreenMemoryService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post("/v1/screen-memory/intervals", {
      schema: { tags: ["screen-memory"], body: IntervalInput },
    }, async (request) => {
      return service.saveInterval(request.body);
    });

    app.get("/v1/screen-memory/intervals", {
      schema: { tags: ["screen-memory"], querystring: ListQuery },
    }, async (request) => {
      const query = request.query;
      return service.listIntervals({
        from: dateOf(query.from),
        to: dateOf(query.to),
        ...(query.bundleId !== undefined ? { bundleId: query.bundleId } : {}),
        ...(query.summaryStatus !== undefined ? { summaryStatus: query.summaryStatus } : {}),
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
      });
    });

    app.get("/v1/screen-memory/intervals/:id", {
      schema: { tags: ["screen-memory"], params: Type.Object({ id: Type.String({ minLength: 8, maxLength: 64 }) }) },
    }, async (request, reply) => {
      const interval = await service.getInterval(request.params.id);
      if (!interval) return reply.code(404).send({ error: "screen_interval_not_found" });
      return interval;
    });

    app.get("/v1/screen-memory/search", {
      schema: { tags: ["screen-memory"], querystring: SearchQuery },
    }, async (request) => {
      const query = request.query;
      return service.searchIntervals({
        q: query.q,
        ...(query.bundleId !== undefined ? { bundleId: query.bundleId } : {}),
        from: dateOf(query.from),
        to: dateOf(query.to),
        limit: query.limit ?? 50,
      });
    });

    app.patch("/v1/screen-memory/intervals/:id", {
      schema: {
        tags: ["screen-memory"],
        params: Type.Object({ id: Type.String({ minLength: 8, maxLength: 64 }) }),
        body: Type.Object({
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
          textLines: Type.Optional(Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 5_000 })),
          textBlocks: Type.Optional(Type.Array(Type.String({ maxLength: 20_000 }), { maxItems: 1_000 })),
        }),
      },
    }, async (request, reply) => {
      const updated = await service.updateInterval(request.params.id, request.body);
      if (!updated) return reply.code(404).send({ error: "screen_interval_not_found" });
      return updated;
    });

    app.get("/v1/screen-memory/stats", {
      schema: { tags: ["screen-memory"] },
    }, async () => service.stats());

    app.post("/v1/screen-memory/intervals/:id/register-material", {
      schema: {
        tags: ["screen-memory"],
        params: Type.Object({ id: Type.String({ minLength: 8, maxLength: 64 }) }),
      },
    }, async (request, reply) => {
      try {
        const result = await service.registerMaterial(request.params.id);
        if (!result) return reply.code(404).send({ error: "screen_interval_not_found" });
        return result;
      } catch (error) {
        const code = error instanceof Error ? error.message : "register_material_failed";
        return reply.code(code === "screen_interval_not_found" ? 404 : 400).send({ error: code });
      }
    });

    app.post("/v1/screen-memory/backfill/estimate", {
      schema: {
        tags: ["screen-memory"],
        body: Type.Object({
          from: Type.String({ format: "date-time" }),
          to: Type.String({ format: "date-time" }),
        }),
      },
    }, async (request) => {
      return service.backfillEstimate({ from: new Date(request.body.from), to: new Date(request.body.to) });
    });

    app.post("/v1/screen-memory/backfill/batch", {
      schema: {
        tags: ["screen-memory"],
        body: Type.Object({
          from: Type.String({ format: "date-time" }),
          to: Type.String({ format: "date-time" }),
          afterCapturedAt: Type.Optional(Type.String({ format: "date-time" })),
          limit: Type.Integer({ minimum: 1, maximum: 25 }),
        }),
      },
    }, async (request) => {
      return service.backfillScreenshotBatch({
        from: new Date(request.body.from),
        to: new Date(request.body.to),
        ...(request.body.afterCapturedAt !== undefined ? { afterCapturedAt: new Date(request.body.afterCapturedAt) } : {}),
        limit: request.body.limit,
      });
    });

    app.post("/v1/screen-memory/summary-control", {
      schema: {
        tags: ["screen-memory"],
        body: Type.Object({ dispatchAllowed: Type.Boolean() }),
      },
    }, async (request) => {
      service.setSummaryDispatch(request.body.dispatchAllowed);
      return { ok: true };
    });
  };
}
