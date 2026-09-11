import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { SessionTitleService } from "./session-title.js";
import type { TranscriptionSummaryService } from "./service.js";

export function processingRoutes(
  service: TranscriptionSummaryService,
  titleService: SessionTitleService,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post(
      "/v1/processing/transcription-summary",
      {
        bodyLimit: 2 * 1024 * 1024,
        schema: {
          tags: ["processing"],
          body: Type.Object({
            jobId: Type.String({ minLength: 1, maxLength: 100 }),
            sourceRecordId: Type.String({ minLength: 1, maxLength: 100 }),
            transcript: Type.String({ minLength: 1, maxLength: 2_000_000 }),
            language: Type.Optional(Type.String({ minLength: 2, maxLength: 20 })),
            // 桌面端校验失败后的定向修复提示（第二次尝试携带）。
            repairHint: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
          }),
        },
      },
      async (request, reply) => {
        try {
          return await service.summarize(request.body);
        } catch (error) {
          if (error instanceof Error && error.message === "summary_job_busy") {
            return reply.code(409).send({ error: "job_busy", message: "Summary job is already running" });
          }
          throw error;
        }
      },
    );

    app.post(
      "/v1/processing/session-title",
      {
        bodyLimit: 256 * 1024,
        schema: {
          tags: ["processing"],
          body: Type.Object({
            sessionId: Type.String({ minLength: 1, maxLength: 100 }),
            userText: Type.String({ minLength: 1, maxLength: 20_000 }),
            assistantText: Type.String({ minLength: 0, maxLength: 20_000 }),
            language: Type.Optional(Type.String({ minLength: 2, maxLength: 20 })),
          }),
          response: {
            200: Type.Object({ title: Type.String() }),
            503: Type.Object({ error: Type.String(), message: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        try {
          return await titleService.generate(request.body);
        } catch (error) {
          if (error instanceof Error && error.message === "title_runtime_unavailable") {
            return reply.code(503).send({ error: "title_runtime_unavailable", message: "Session title runtime is not configured" });
          }
          throw error;
        }
      },
    );
  };
}
