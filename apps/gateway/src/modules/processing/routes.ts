import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { TranscriptionSummaryService } from "./service.js";

export function processingRoutes(service: TranscriptionSummaryService): FastifyPluginAsyncTypebox {
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
  };
}
