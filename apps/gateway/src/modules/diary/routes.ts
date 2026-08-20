import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { DiaryService } from "./service.js";

const DateParams = Type.Object({ date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }) });
const RunParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }) });

export function diaryRoutes(service: DiaryService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/diary/settings", { schema: { tags: ["diary"] } }, async () => service.getSettings());
    app.patch("/v1/diary/settings", { schema: { tags: ["diary"], body: Type.Object({ enabled: Type.Optional(Type.Boolean()), localTime: Type.Optional(Type.String()), timezone: Type.Optional(Type.String()), enabledFrom: Type.Optional(Type.Union([Type.String(), Type.Null()])), configVersion: Type.Integer({ minimum: 1 }) }) } }, async (request, reply) => {
      try { return service.updateSettings(request.body); }
      catch (error) {
        if (error instanceof Error && error.message === "diary_settings_conflict") return reply.code(409).send({ error: error.message });
        throw error;
      }
    });
    app.get("/v1/diary/days", { schema: { tags: ["diary"], querystring: Type.Object({ start: Type.Optional(DateParams.properties.date), end: Type.Optional(DateParams.properties.date), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }) } }, async (request) => service.listDays(request.query.limit, request.query.offset, request.query.start, request.query.end));
    app.get("/v1/diary/days/:date", { schema: { tags: ["diary"], params: DateParams } }, async (request, reply) => { const result = service.getDay(request.params.date); return result.day ? result : reply.code(404).send({ error: "not_found" }); });
    app.post("/v1/diary/days/:date/generate", { schema: { tags: ["diary"], params: DateParams } }, async (request, reply) => { const runId = service.createRun(request.params.date, "manual"); void service.drain(); return reply.code(202).send({ runId }); });
    app.get("/v1/diary/days/:date/versions", { schema: { tags: ["diary"], params: DateParams } }, async (request) => service.listVersions(request.params.date));
    app.post("/v1/diary/days/:date/versions/:versionId/activate", { schema: { tags: ["diary"], params: Type.Object({ date: DateParams.properties.date, versionId: Type.String({ minLength: 1 }) }) } }, async (request) => service.activate(request.params.date, request.params.versionId));
    app.get("/v1/diary/runs/active", { schema: { tags: ["diary"] } }, async () => service.getActiveRun());
    app.get("/v1/diary/runs/:id", { schema: { tags: ["diary"], params: RunParams } }, async (request, reply) => service.getRun(request.params.id) ?? reply.code(404).send({ error: "not_found" }));
  };
}
