import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { AsrError } from "./errors.js";
import type { AsrService } from "./service.js";

const JobParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }) });
const JobSchema = Type.Object({
  id: Type.String(),
  provider: Type.String(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  fileName: Type.String(),
  languageHints: Type.Array(Type.String()),
  diarizationEnabled: Type.Boolean(),
  contextPrompt: Type.String(),
  result: Type.Union([Type.Unknown(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export function asrRoutes(service: AsrService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post(
      "/v1/asr/jobs",
      {
        schema: {
          tags: ["asr"],
          body: Type.Object({
            filePath: Type.String({ minLength: 1, maxLength: 4096 }),
            languageHints: Type.Optional(Type.Array(
              Type.String({ minLength: 2, maxLength: 16 }),
              { maxItems: 10, uniqueItems: true },
            )),
            diarizationEnabled: Type.Optional(Type.Boolean({ default: true })),
            contextPrompt: Type.Optional(Type.String({ maxLength: 400 })),
          }),
          response: { 202: JobSchema },
        },
      },
      async (request, reply) => reply.code(202).send(await service.createJob({
        filePath: request.body.filePath,
        ...(request.body.languageHints ? { languageHints: request.body.languageHints } : {}),
        diarizationEnabled: request.body.diarizationEnabled ?? true,
        ...(request.body.contextPrompt ? { contextPrompt: request.body.contextPrompt } : {}),
      })),
    );

    app.get(
      "/v1/asr/jobs/:id",
      { schema: { tags: ["asr"], params: JobParams, response: { 200: JobSchema } } },
      async (request, reply) => {
        const job = await service.getJob(request.params.id);
        if (!job) {
          throw new AsrError("asr_job_not_found", "ASR job was not found", 404);
        }
        return reply.send(job);
      },
    );
  };
}
