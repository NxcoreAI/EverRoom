import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { IngestError } from "./types.js";
import type { IngestEventDto, IngestService } from "./service.js";
import { listPolicyViews } from "./policy.js";

const PipelinesSchema = Type.Object({
  room: Type.Boolean(),
  wiki: Type.Boolean(),
  memory: Type.Boolean(),
});

const IngestBody = Type.Object({
  source: Type.Object({
    /** 本地路径（逃生舱：只读不拷贝，U8）。 */
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    ref: Type.Optional(Type.Object({
      sourceKind: Type.Union([
        Type.Literal("file"),
        Type.Literal("everroom-doc"),
        Type.Literal("reality-event"),
      ]),
      sourceId: Type.String({ minLength: 1, maxLength: 200 }),
    })),
  }),
  dataType: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  occurredAt: Type.Optional(Type.String()),
  pipelines: Type.Optional(PipelinesSchema),
  entrySignals: Type.Optional(Type.Object({
    sourceTag: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    filenamePrefix: Type.Optional(Type.String()),
    creatorId: Type.Optional(Type.String()),
  })),
  originChannel: Type.Optional(Type.Union([
    Type.Literal("file"),
    Type.Literal("paste-file"),
    Type.Literal("connector"),
    Type.Literal("reality"),
    Type.Literal("everroom-doc"),
    Type.Literal("upload"),
  ])),
});

const MemoryResultSchema = Type.Union([
  Type.Object({
    documentId: Type.String(),
    chunkCount: Type.Integer(),
    deduplicated: Type.Boolean(),
  }),
  Type.Object({ error: Type.String() }),
  Type.Null(),
]);

const IngestResultSchema = Type.Object({
  eventId: Type.String(),
  deduped: Type.Boolean(),
  source: Type.Object({
    sourceKind: Type.String(),
    sourceId: Type.String(),
    sourceVersion: Type.Integer(),
  }),
  dataType: Type.String(),
  detectedBy: Type.String(),
  title: Type.String(),
  contentHash: Type.String(),
  parsedId: Type.String(),
  pipelines: PipelinesSchema,
  routeJobId: Type.Union([Type.String(), Type.Null()]),
  memoryResult: MemoryResultSchema,
  originChannel: Type.String(),
});

const IngestEventDtoSchema = Type.Object({
  id: Type.String(),
  sourceKind: Type.String(),
  sourceId: Type.String(),
  sourceVersion: Type.Integer(),
  dataType: Type.String(),
  detectedBy: Type.String(),
  title: Type.String(),
  contentHash: Type.String(),
  parsedId: Type.String(),
  pipelines: PipelinesSchema,
  memoryResult: MemoryResultSchema,
  routeJobId: Type.Union([Type.String(), Type.Null()]),
  originChannel: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const PolicyViewSchema = Type.Object({
  key: Type.String(),
  label: Type.String(),
  matchExtensions: Type.Array(Type.String()),
  jsonType: Type.Union([Type.String(), Type.Null()]),
  defaults: PipelinesSchema,
  projectDefaults: Type.Union([PipelinesSchema, Type.Null()]),
  fileOverride: Type.Union([PipelinesSchema, Type.Null()]),
  effective: PipelinesSchema,
  source: Type.Union([Type.Literal("code"), Type.Literal("project"), Type.Literal("deploy")]),
});

const ErrorSchema = Type.Object({ error: Type.String(), message: Type.String() });

const errorCodes = ["source_required", "source_conflict", "path_unreadable", "ref_not_found",
  "unsupported_type", "unknown_data_type", "invalid_pipelines", "no_pipelines",
  "convert_failed", "empty_content", "router_disabled"] as const;

const ErrorResponse = Type.Object({
  error: Type.Union(errorCodes.map((code) => Type.Literal(code))),
  message: Type.String(),
});

/**
 * 统一理解引擎 REST（unified-ingest-plan §9）：POST /v1/ingest 是接入面
 * 唯一入口（path 或 ref，U8）；台账查询与策略只读展示（覆盖走配置文件，
 * 部署期改，无写接口）。
 */
export function ingestRoutes(service: IngestService): FastifyPluginAsyncTypebox {
  return async (app) => {
    // IngestError → {error, message} + 对应状态码；其余（AJV 校验等）走默认
    app.setErrorHandler(async (error, _request, reply) => {
      if (error instanceof IngestError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      return reply.send(error);
    });

    app.post(
      "/v1/ingest",
      {
        schema: {
          tags: ["ingest"],
          body: IngestBody,
          response: {
            200: IngestResultSchema,
            201: IngestResultSchema,
            400: ErrorResponse,
            404: ErrorResponse,
            422: ErrorResponse,
          },
        },
      },
      async (request, reply) => {
        const result = await service.ingest(request.body);
        return reply.code(result.deduped ? 200 : 201).send(result);
      },
    );

    app.get(
      "/v1/ingest",
      {
        schema: {
          tags: ["ingest"],
          querystring: Type.Object({
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
            offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
            sourceKind: Type.Optional(Type.String()),
            sourceId: Type.Optional(Type.String()),
          }),
          response: {
            200: Type.Object({ items: Type.Array(IngestEventDtoSchema), total: Type.Integer() }),
          },
        },
      },
      async (request) => {
        return service.listEvents(request.query);
      },
    );

    // 策略只读展示：代码兜底 ⨝ 工程默认文件 ⨝ 部署覆盖文件（改策略 = 改文件重启，无写接口）
    app.get(
      "/v1/ingest/policies",
      {
        schema: {
          tags: ["ingest"],
          response: { 200: Type.Object({ items: Type.Array(PolicyViewSchema) }) },
        },
      },
      async () => ({ items: listPolicyViews(service.policy) }),
    );

    app.get(
      "/v1/ingest/:id",
      {
        schema: {
          tags: ["ingest"],
          params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }),
          response: {
            200: IngestEventDtoSchema,
            404: ErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const event: IngestEventDto | null = service.getEvent(request.params.id);
        if (!event) throw new IngestError("台账无此事件", "ref_not_found", 404);
        return event;
      },
    );
  };
}
