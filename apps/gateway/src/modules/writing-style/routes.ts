import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { WritingStyleService, WritingStyleServiceError } from "./service.js";

const SettingsBody = Type.Object({
  completionEnabled: Type.Optional(Type.Boolean()),
  generationEnabled: Type.Optional(Type.Boolean()),
});

const UserContentBody = Type.Object({
  content: Type.String({ maxLength: 2_100 }),
});

const ExclusionBody = Type.Object({
  excluded: Type.Boolean(),
});

function errorStatus(code: string): number {
  if (code === "writing_style_not_found") return 404;
  return 400;
}

export function writingStyleRoutes(service: WritingStyleService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/writing-style", { schema: { tags: ["writing-style"] } }, async () => {
      return service.getProfile();
    });

    app.get("/v1/writing-style/settings", { schema: { tags: ["writing-style"] } }, async () => {
      return service.getSettings();
    });

    app.put("/v1/writing-style/settings", { schema: { tags: ["writing-style"], body: SettingsBody } }, async (request, reply) => {
      try {
        return service.updateSettings(request.body);
      } catch (error) {
        if (error instanceof WritingStyleServiceError) {
          return reply.status(errorStatus(error.code)).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    });

    app.get("/v1/writing-style/user-content", { schema: { tags: ["writing-style"] } }, async () => {
      return service.getProfileText();
    });

    app.put("/v1/writing-style/user-content", { schema: { tags: ["writing-style"], body: UserContentBody } }, async (request, reply) => {
      try {
        return service.replaceUserContent(request.body.content);
      } catch (error) {
        if (error instanceof WritingStyleServiceError) {
          return reply.status(errorStatus(error.code)).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    });

    app.post("/v1/writing-style/user-content/regenerate", { schema: { tags: ["writing-style"] } }, async () => {
      return service.regenerateProfileText();
    });

    app.post("/v1/writing-style/recompute", { schema: { tags: ["writing-style"] } }, async () => {
      return service.recompute();
    });

    app.post("/v1/writing-style/backfill", { schema: { tags: ["writing-style"] } }, async () => {
      return service.backfill();
    });

    app.get("/v1/writing-style/corpus", { schema: { tags: ["writing-style"] } }, async () => {
      return { documents: service.listCorpus() };
    });

    // 协作轮洞察（v2）：pending 供智能区横幅轮询；snoozed 可回记忆页找回确认。
    app.get("/v1/writing-style/insights", { schema: { tags: ["writing-style"] } }, async () => {
      return { insights: service.listInsights() };
    });

    app.post("/v1/writing-style/insights/:id/snooze", { schema: { tags: ["writing-style"] } }, async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return service.snoozeInsight(id);
      } catch (error) {
        if (error instanceof WritingStyleServiceError) {
          return reply.status(errorStatus(error.code)).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    });

    app.post("/v1/writing-style/insights/:id/confirm", { schema: { tags: ["writing-style"] } }, async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return service.confirmInsight(id);
      } catch (error) {
        if (error instanceof WritingStyleServiceError) {
          return reply.status(errorStatus(error.code)).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    });

    app.post("/v1/writing-style/documents/:documentId/exclusion", { schema: { tags: ["writing-style"], body: ExclusionBody } }, async (request, reply) => {
      const { documentId } = request.params as { documentId: string };
      try {
        service.setExclusion(documentId, request.body.excluded);
        return { ok: true };
      } catch (error) {
        if (error instanceof WritingStyleServiceError) {
          return reply.status(errorStatus(error.code)).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    });
  };
}
