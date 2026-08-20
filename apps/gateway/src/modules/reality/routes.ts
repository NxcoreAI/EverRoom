import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { REALITY_PROTOCOL_VERSION } from "@nxcore/reality-contract";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { RealityError } from "./errors.js";
import type { RealityService } from "./service.js";

const IdParams = Type.Object({
  id: Type.String({ minLength: 36, maxLength: 100 }),
});
const JobParams = Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 120 }) });

const RealityTagSchema = Type.Object({
  id: Type.Optional(Type.String()),
  kind: Type.Union([Type.Literal("entity"), Type.Literal("fact")]),
  label: Type.String(),
  normalizedKey: Type.Optional(Type.String()),
  entityType: Type.Optional(Type.Union([
    Type.Literal("person"), Type.Literal("organization"), Type.Literal("project"),
    Type.Literal("product"), Type.Literal("place"), Type.Literal("other"),
  ])),
  subject: Type.Optional(Type.String()),
  predicate: Type.Optional(Type.String()),
  object: Type.Optional(Type.String()),
  confidence: Type.Optional(Type.Number()),
  evidence: Type.Optional(Type.String()),
  occurrenceCount: Type.Optional(Type.Integer()),
});

const AsrBody = Type.Object({
  jobId: Type.String({ minLength: 1, maxLength: 120 }),
  source: Type.Union([Type.Literal("local"), Type.Literal("saas")]),
  status: Type.Union([
    Type.Literal("pending"), Type.Literal("running"), Type.Literal("completed"),
    Type.Literal("failed"), Type.Literal("cancelled"),
  ]),
  result: Type.Optional(Type.Union([Type.Object({
    transcript: Type.String(),
    insights: Type.Optional(Type.Object({
      source: Type.Optional(Type.Union([Type.Literal("mock"), Type.Literal("generated")])),
      eventType: Type.Optional(Type.Union([
        Type.Literal("MEETING"), Type.Literal("MEAL"), Type.Literal("WORK"),
        Type.Literal("SOCIAL"), Type.Literal("LEARNING"), Type.Literal("CHITCHAT"),
        Type.Literal("REST"), Type.Literal("EXERCISE"), Type.Literal("OTHER"),
      ])),
      currentTopic: Type.Union([Type.String(), Type.Null()]),
      summary: Type.Union([Type.String(), Type.Null()]),
      keyPoints: Type.Array(Type.String()),
      decisions: Type.Array(Type.String()),
      actionItems: Type.Array(Type.String()),
      people: Type.Array(Type.String()),
      projects: Type.Array(Type.String()),
      unresolvedQuestions: Type.Array(Type.String()),
    })),
    segments: Type.Array(Type.Object({
      text: Type.String(),
      beginTime: Type.Number({ minimum: 0 }),
      endTime: Type.Number({ minimum: 0 }),
      speakerId: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    })),
  }), Type.Null()])),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  resultVersion: Type.Optional(Type.Integer({ minimum: 1 })),
});

const StatusSchema = Type.Union([
  Type.Literal("ongoing"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("pending_sync"),
]);

const InsightsSchema = Type.Object({
  source: Type.Optional(Type.Union([Type.Literal("mock"), Type.Literal("generated")])),
  eventType: Type.Optional(Type.Union([
    Type.Literal("MEETING"), Type.Literal("MEAL"), Type.Literal("WORK"),
    Type.Literal("SOCIAL"), Type.Literal("LEARNING"), Type.Literal("CHITCHAT"),
    Type.Literal("REST"), Type.Literal("EXERCISE"), Type.Literal("OTHER"),
  ])),
  currentTopic: Type.Union([Type.String(), Type.Null()]),
  summary: Type.Union([Type.String(), Type.Null()]),
  keyPoints: Type.Array(Type.String()),
  decisions: Type.Array(Type.String()),
  actionItems: Type.Array(Type.String()),
  people: Type.Array(Type.String()),
  projects: Type.Array(Type.String()),
  unresolvedQuestions: Type.Array(Type.String()),
  representativeTags: Type.Optional(Type.Array(RealityTagSchema)),
  summaryRecordId: Type.Optional(Type.String()),
});

function audioType(path: string): string {
  const types: Record<string, string> = {
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function realityRoutes(service: RealityService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/reality/events",
      {
        schema: {
          tags: ["reality"],
          querystring: Type.Object({
            status: Type.Optional(StatusSchema),
            search: Type.Optional(Type.String({ maxLength: 200 })),
          }),
        },
      },
      async (request) => service.listEvents(request.query),
    );

    app.post(
      "/v1/reality/events",
      {
        schema: {
          tags: ["reality"],
          body: Type.Object({
            id: Type.String({ format: "uuid" }),
            title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            captureDevice: Type.Object({
              id: Type.String({ minLength: 1, maxLength: 120 }),
              name: Type.String({ minLength: 1, maxLength: 120 }),
              kind: Type.Union([Type.Literal("desktop"), Type.Literal("iphone"), Type.Literal("apple_watch")]),
            }),
            audioSource: Type.Union([Type.Literal("microphone"), Type.Literal("system")]),
            audioMimeType: Type.Optional(Type.String({ maxLength: 120 })),
            contextPrompt: Type.Optional(Type.String({ maxLength: 400 })),
            startedAt: Type.Optional(Type.String({ format: "date-time" })),
          }),
        },
      },
      async (request, reply) => reply.code(201).send(service.createEvent(request.body)),
    );

    app.put(
      "/v1/reality/events/:id/import",
      {
        schema: {
          tags: ["reality"],
          params: IdParams,
          body: Type.Object({
            id: Type.String({ format: "uuid" }),
            title: Type.String({ minLength: 1, maxLength: 120 }),
            captureDevice: Type.Object({
              id: Type.String({ minLength: 1, maxLength: 120 }),
              name: Type.String({ minLength: 1, maxLength: 120 }),
              kind: Type.Union([Type.Literal("desktop"), Type.Literal("iphone"), Type.Literal("apple_watch")]),
            }),
            audioSource: Type.Union([Type.Literal("microphone"), Type.Literal("system")]),
            durationMs: Type.Integer({ minimum: 0 }),
            transcript: Type.String({ maxLength: 2_000_000 }),
            transcriptSegments: Type.Array(Type.Object({
              text: Type.String(),
              beginTime: Type.Number({ minimum: 0 }),
              endTime: Type.Number({ minimum: 0 }),
              speakerId: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
            })),
            insights: Type.Optional(InsightsSchema),
            resultVersion: Type.Integer({ minimum: 1 }),
            startedAt: Type.String({ format: "date-time" }),
            endedAt: Type.String({ format: "date-time" }),
          }),
        },
      },
      async (request) => {
        if (request.params.id !== request.body.id) {
          throw new RealityError("import_id_mismatch", "Imported reality event id does not match the route", 400);
        }
        return service.importEvent(request.body);
      },
    );

    app.get(
      "/v1/reality/events/:id",
      { schema: { tags: ["reality"], params: IdParams } },
      async (request, reply) => service.getEvent(request.params.id)
        ?? reply.code(404).send({ error: "not_found", message: "Reality event not found" }),
    );

    app.delete(
      "/v1/reality/events/:id",
      { schema: { tags: ["reality"], params: IdParams } },
      async (request, reply) => {
        await service.discard(request.params.id);
        return reply.code(204).send();
      },
    );

    app.post(
      "/v1/reality/events/:id/capture-finished",
      {
        schema: {
          tags: ["reality"],
          params: IdParams,
          body: Type.Object({
            durationMs: Type.Integer({ minimum: 0 }),
            audioFileName: Type.String({ minLength: 1, maxLength: 4096 }),
            endedAt: Type.Optional(Type.String({ format: "date-time" })),
          }),
        },
      },
      async (request) => service.finishCapture(request.params.id, request.body),
    );

    app.post(
      "/v1/reality/events/:id/asr",
      {
        schema: {
          tags: ["reality"],
          params: IdParams,
          body: AsrBody,
        },
      },
      async (request) => service.applyAsr(request.params.id, request.body),
    );

    app.post(
      "/v1/reality/asr-jobs/:jobId",
      { schema: { tags: ["reality"], params: JobParams, body: AsrBody } },
      async (request) => service.applyAsrByJob(request.params.jobId, request.body),
    );

    app.patch(
      "/v1/reality/events/:id/transcript",
      {
        schema: {
          tags: ["reality"],
          params: IdParams,
          body: Type.Object({
            transcript: Type.String({ maxLength: 2_000_000 }),
            expectedVersion: Type.Integer({ minimum: 1 }),
          }),
        },
      },
      async (request) => service.updateTranscript(request.params.id, request.body),
    );

    app.post(
      "/v1/reality/events/:id/markers",
      {
        schema: {
          tags: ["reality"],
          params: IdParams,
          body: Type.Object({
            atMs: Type.Integer({ minimum: 0 }),
            label: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
          }),
        },
      },
      async (request) => service.addMarker(request.params.id, request.body),
    );

    app.patch(
      "/v1/reality/events/:id/important",
      {
        schema: {
          tags: ["reality"],
          params: IdParams,
          body: Type.Object({ important: Type.Boolean() }),
        },
      },
      async (request) => service.setImportant(request.params.id, request.body.important),
    );

    app.post(
      "/v1/reality/events/:id/confirm",
      { schema: { tags: ["reality"], params: IdParams } },
      async (request) => service.confirm(request.params.id),
    );

    app.post(
      "/v1/reality/events/:id/knowledge-ingest",
      { schema: { tags: ["reality"], params: IdParams } },
      async (request) => service.ingestToKnowledge(request.params.id),
    );

    app.post(
      "/v1/reality/events/:id/fail",
      {
        schema: {
          tags: ["reality"],
          params: IdParams,
          body: Type.Object({ error: Type.String({ minLength: 1, maxLength: 2_000 }) }),
        },
      },
      async (request) => service.fail(request.params.id, request.body.error),
    );

    app.get(
      "/v1/reality/events/:id/audio",
      { schema: { tags: ["reality"], params: IdParams } },
      async (request, reply) => {
        const path = await service.audioPath(request.params.id);
        return reply.type(audioType(path)).send(createReadStream(path));
      },
    );

    app.get(
      "/v1/reality/stream",
      { websocket: true },
      (socket) => {
        const unsubscribe = service.broker.subscribe(socket);
        socket.send(JSON.stringify({ type: "ready", protocol: REALITY_PROTOCOL_VERSION }));
        socket.once("close", unsubscribe);
      },
    );
  };
}
