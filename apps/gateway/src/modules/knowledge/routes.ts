import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { KnowledgeService } from "./service.js";

const RoomOriginQuery = Type.Object({
  origin: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("auto")])),
});

const RoomUpsertBody = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 200 }),
  title: Type.String({ minLength: 1, maxLength: 120 }),
  kind: Type.Optional(Type.String({ minLength: 1, maxLength: 24 })),
});

const RoomDto = Type.Object({
  id: Type.String(),
  title: Type.String(),
  kind: Type.String(),
  origin: Type.String(),
  summary: Type.Union([Type.String(), Type.Null()]),
  aliases: Type.Array(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const WikiDto = Type.Object({
  roomId: Type.String(),
  knowledgeId: Type.String(),
  status: Type.String(),
  createdAt: Type.String(),
});

const RoomIdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) });

/** wiki 页面目录项（KS page/ls 透传，ref=path）。 */
const WikiPageDto = Type.Object({
  id: Type.String(),
  title: Type.String(),
  type: Type.String(),
  path: Type.String(),
  description: Type.Optional(Type.String()),
});

const MaterialDto = Type.Object({
  documentId: Type.String(),
  title: Type.String(),
  version: Type.Integer(),
  updatedAt: Type.String(),
  ingested: Type.Boolean(),
});

const EntrySignalsSchema = Type.Object({
  sourceTag: Type.Optional(Type.String({ maxLength: 200 })),
  threadId: Type.Optional(Type.String({ maxLength: 200 })),
  filenamePrefix: Type.Optional(Type.String({ maxLength: 500 })),
  creatorId: Type.Optional(Type.String({ maxLength: 200 })),
});

const ManualRouteBody = Type.Union([
  Type.Object({
    sourceKind: Type.Optional(Type.Literal("everroom-doc")),
    sourceId: Type.String({ minLength: 1, maxLength: 200 }),
  }),
  Type.Object({
    /** 外部信封（连接器契约，plan §5.1）：非 everroom-doc 源必填。 */
    sourceKind: Type.Union([
      Type.Literal("reality-event"),
      Type.Literal("mail"),
      Type.Literal("file"),
      Type.Literal("cloud-doc"),
    ]),
    sourceId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    sourceVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    markdown: Type.String({ minLength: 1, maxLength: 512 * 1024 }),
    occurredAt: Type.Optional(Type.String({ maxLength: 40 })),
    entrySignals: Type.Optional(EntrySignalsSchema),
  }),
]);

/** 候选实体卡片（entity-room-plan §4.7）：弱期概述由 UI 从依据句派生（ED7）。 */
const EntityDto = Type.Object({
  id: Type.String(),
  name: Type.String(),
  kind: Type.String(),
  status: Type.String(),
  roomId: Type.Union([Type.String(), Type.Null()]),
  evidenceScore: Type.Number(),
  sourceCount: Type.Integer(),
  promoteScore: Type.Number(),
  promoteSources: Type.Integer(),
  firstEvidence: Type.Union([Type.String(), Type.Null()]),
  lastLinkedAt: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.String(),
});

const EntityStatusQuery = Type.Object({
  status: Type.Optional(Type.Union([
    Type.Literal("weak"),
    Type.Literal("ready"),
    Type.Literal("promoting"),
    Type.Literal("room"),
    Type.Literal("archived"),
  ])),
});

const EntityIdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }) });

const EntityLinkDto = Type.Object({
  id: Type.String(),
  entityId: Type.String(),
  sourceKind: Type.String(),
  sourceId: Type.String(),
  sourceVersion: Type.Integer(),
  role: Type.String(),
  salience: Type.Number(),
  evidence: Type.Union([Type.String(), Type.Null()]),
  decidedBy: Type.String(),
  sourceTitle: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const EntityDetailDto = Type.Object({
  entity: Type.Object({
    id: Type.String(),
    name: Type.String(),
    aliases: Type.Array(Type.String()),
    kind: Type.String(),
    summary: Type.Union([Type.String(), Type.Null()]),
    status: Type.String(),
    roomId: Type.Union([Type.String(), Type.Null()]),
    evidenceScore: Type.Number(),
    sourceCount: Type.Integer(),
    mergedFrom: Type.Array(Type.String()),
    lastLinkedAt: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  }),
  room: Type.Union([
    Type.Null(),
    Type.Object({ id: Type.String(), title: Type.String(), kind: Type.String() }),
  ]),
  links: Type.Array(EntityLinkDto),
});

const EntityMergeBody = Type.Object({
  /** 并入的目标实体 id（from = 路径里的 :id）。 */
  targetId: Type.String({ minLength: 1, maxLength: 100 }),
});

const DocSourceParams = Type.Object({
  sourceKind: Type.Union([
    Type.Literal("everroom-doc"),
    Type.Literal("reality-event"),
    Type.Literal("mail"),
    Type.Literal("file"),
    Type.Literal("cloud-doc"),
  ]),
  sourceId: Type.String({ minLength: 1, maxLength: 200 }),
});

/** 未识别资料手动挂实体：选既有实体，或就地新建（plan §4.7）。 */
const AttachBody = Type.Object({
  entityId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  createEntity: Type.Optional(Type.Object({
    name: Type.String({ minLength: 1, maxLength: 120 }),
    kind: Type.String({ minLength: 1, maxLength: 24 }),
  })),
});

/** 未识别栏条目（抽取空/失败的资料，等待人工挂载）。 */
const UnmatchedItemDto = Type.Object({
  decisionId: Type.String(),
  sourceKind: Type.String(),
  sourceId: Type.String(),
  title: Type.String(),
  summary: Type.Union([Type.String(), Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});

/** wiki 内链图谱（页面=节点、md 内链=边；无 wiki/失败为空图）。 */
const WikiGraphResponse = Type.Object({
  nodes: Type.Array(Type.Object({
    id: Type.String(),
    title: Type.String(),
    path: Type.String(),
    inLinks: Type.Integer(),
  })),
  edges: Type.Array(Type.Object({
    source: Type.String(),
    target: Type.String(),
  })),
});

/** Room 的上传文件清单项（uploaded_files ⨝ 最新 file 决策）。 */
const RoomFileDto = Type.Object({
  id: Type.String(),
  originalName: Type.String(),
  bytes: Type.Integer(),
  title: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  decidedBy: Type.Union([Type.String(), Type.Null()]),
  confidence: Type.Union([Type.Number(), Type.Null()]),
  uploadedAt: Type.String(),
});

const RuleMatcherSchema = Type.Object({
  sourceTag: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  filenamePrefix: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  threadId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  titleKeyword: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  creatorId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

const RuleDto = Type.Object({
  id: Type.String(),
  matcher: Type.Record(Type.String(), Type.Unknown()),
  targetRoomId: Type.String(),
  enabled: Type.Boolean(),
  hitCount: Type.Integer(),
  lastHitAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});

function iso(value: Date): string {
  return value.toISOString();
}

function errorOf(code: string): { error: string } {
  return { error: code };
}

/**
 * Knowledge 模块 REST（entity-room-plan §7）。
 * Room 注册表（渲染器上报/拉取）+ Room↔Wiki 映射 + 派生资料视图 +
 * 手动"立即沉淀"/外部信封入口 + 候选实体（列表/详情/转正/合并）+
 * 未识别栏（挂载）+ 最近归类撤销 + ②b 规则 CRUD。
 */
export function knowledgeRoutes(service: KnowledgeService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/knowledge/rooms",
      {
        schema: {
          tags: ["knowledge"],
          querystring: RoomOriginQuery,
          response: {
            200: Type.Object({ items: Type.Array(RoomDto) }),
          },
        },
      },
      async (request) => ({
        items: service.listRooms(request.query.origin).map((room) => ({
          ...room,
          createdAt: iso(room.createdAt),
          updatedAt: iso(room.updatedAt),
        })),
      }),
    );

    app.post(
      "/v1/knowledge/rooms",
      {
        schema: {
          tags: ["knowledge"],
          body: RoomUpsertBody,
          response: { 201: RoomDto },
        },
      },
      async (request, reply) => {
        const room = service.upsertRoom(request.body);
        return reply.code(201).send({
          ...room,
          createdAt: iso(room.createdAt),
          updatedAt: iso(room.updatedAt),
        });
      },
    );

    app.delete(
      "/v1/knowledge/rooms/:id",
      {
        schema: {
          tags: ["knowledge"],
          params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }),
        },
      },
      async (request, reply) => {
        const deleted = service.deleteRoom(request.params.id);
        if (!deleted) return reply.code(404).send(errorOf("room_not_found"));
        return reply.code(204).send();
      },
    );

    app.get(
      "/v1/knowledge/rooms/:id/wiki/pages",
      {
        schema: {
          tags: ["knowledge"],
          params: RoomIdParams,
          response: {
            200: Type.Object({
              /** none = Room 尚无 wiki（懒创建未触发）；processing = ingest 进行中 */
              status: Type.String(),
              items: Type.Array(WikiPageDto),
              /** KS 内部已产出页数（processing 期间 ls 为空，UI 显示构建进度用） */
              pageCount: Type.Union([Type.Integer(), Type.Null()]),
            }),
          },
        },
      },
      async (request) => service.listRoomWikiPages(request.params.id),
    );

    app.get(
      "/v1/knowledge/rooms/:id/wiki/graph",
      {
        schema: {
          tags: ["knowledge"],
          params: RoomIdParams,
          response: { 200: WikiGraphResponse },
        },
      },
      async (request) => service.wikiGraph(request.params.id),
    );

    app.get(
      "/v1/knowledge/rooms/:id/wiki/pages/*",
      {
        schema: {
          tags: ["knowledge"],
          params: Type.Object({
            id: Type.String({ minLength: 1, maxLength: 200 }),
            "*": Type.String({ minLength: 1, maxLength: 500 }),
          }),
          response: {
            200: Type.Object({ ref: Type.String(), markdown: Type.String() }),
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const ref = request.params["*"];
        const markdown = await service.readRoomWikiPage(request.params.id, ref);
        if (markdown === null) return reply.code(404).send(errorOf("page_not_found"));
        return { ref, markdown };
      },
    );

    app.get(
      "/v1/knowledge/rooms/:id/files",
      {
        schema: {
          tags: ["knowledge"],
          params: RoomIdParams,
          response: {
            200: Type.Object({ items: Type.Array(RoomFileDto) }),
          },
        },
      },
      async (request) => ({
        items: service.listRoomFiles(request.params.id).map((file) => ({
          ...file,
          uploadedAt: iso(file.uploadedAt),
        })),
      }),
    );

    app.get(
      "/v1/knowledge/files/:id/markdown",
      {
        schema: {
          tags: ["knowledge"],
          params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 500 }) }),
          response: {
            200: Type.Object({ markdown: Type.String() }),
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const markdown = service.readFileMarkdown(request.params.id);
        if (markdown === null) return reply.code(404).send(errorOf("file_not_found"));
        return { markdown };
      },
    );

    app.get(
      "/v1/knowledge/files/:id/storage",
      {
        schema: {
          tags: ["knowledge"],
          params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 500 }) }),
          response: {
            200: Type.Object({ storagePath: Type.String() }),
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const storagePath = service.fileStoragePath(request.params.id);
        if (storagePath === null) return reply.code(404).send(errorOf("file_not_found"));
        return { storagePath };
      },
    );

    app.get(
      "/v1/knowledge/rooms/:id/materials",
      {
        schema: {
          tags: ["knowledge"],
          params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }),
          response: {
            200: Type.Object({ items: Type.Array(MaterialDto) }),
          },
        },
      },
      async (request) => ({
        items: service.roomMaterials(request.params.id).map((material) => ({
          ...material,
          updatedAt: iso(material.updatedAt),
        })),
      }),
    );

    app.get(
      "/v1/knowledge/wikis",
      {
        schema: {
          tags: ["knowledge"],
          response: {
            200: Type.Object({ items: Type.Array(WikiDto) }),
          },
        },
      },
      async () => ({
        items: service.listRoomWikis().map((wiki) => ({
          roomId: wiki.roomId,
          knowledgeId: wiki.knowledgeId,
          status: wiki.status,
          createdAt: iso(wiki.createdAt),
        })),
      }),
    );

    app.get(
      "/v1/knowledge/entities",
      {
        schema: {
          tags: ["knowledge"],
          querystring: EntityStatusQuery,
          response: {
            200: Type.Object({ items: Type.Array(EntityDto) }),
          },
        },
      },
      async (request) => ({
        items: service.listCandidateEntities(request.query.status ?? "weak").map((entity) => ({
          ...entity,
          lastLinkedAt: entity.lastLinkedAt ? iso(entity.lastLinkedAt) : null,
          updatedAt: iso(entity.updatedAt),
        })),
      }),
    );

    app.get(
      "/v1/knowledge/entities/:id",
      {
        schema: {
          tags: ["knowledge"],
          params: EntityIdParams,
          response: {
            200: EntityDetailDto,
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const detail = service.getEntityDetail(request.params.id);
        if (!detail.ok) return reply.code(404).send(errorOf(detail.error));
        return {
          entity: {
            id: detail.entity.id,
            name: detail.entity.name,
            aliases: detail.entity.aliases,
            kind: detail.entity.kind,
            summary: detail.entity.summary,
            status: detail.entity.status,
            roomId: detail.entity.roomId,
            evidenceScore: detail.entity.evidenceScore,
            sourceCount: detail.entity.sourceCount,
            mergedFrom: detail.entity.mergedFrom,
            lastLinkedAt: detail.entity.lastLinkedAt ? iso(detail.entity.lastLinkedAt) : null,
            createdAt: iso(detail.entity.createdAt),
            updatedAt: iso(detail.entity.updatedAt),
          },
          room: detail.room,
          links: detail.links.map((link) => ({
            id: link.id,
            entityId: link.entityId,
            sourceKind: link.sourceKind,
            sourceId: link.sourceId,
            sourceVersion: link.sourceVersion,
            role: link.role,
            salience: link.salience,
            evidence: link.evidence,
            decidedBy: link.decidedBy,
            sourceTitle: link.sourceTitle,
            createdAt: iso(link.createdAt),
            updatedAt: iso(link.updatedAt),
          })),
        };
      },
    );

    app.post(
      "/v1/knowledge/entities/:id/promote",
      {
        schema: {
          tags: ["knowledge"],
          params: EntityIdParams,
          response: {
            202: Type.Object({ queued: Type.Boolean() }),
            400: Type.Object({ error: Type.String() }),
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const result = service.promoteEntity(request.params.id);
        if (!result.ok) {
          const status = result.error === "entity_not_found" ? 404 : 400;
          return reply.code(status).send(errorOf(result.error));
        }
        return reply.code(202).send({ queued: true });
      },
    );

    app.post(
      "/v1/knowledge/entities/:id/merge",
      {
        schema: {
          tags: ["knowledge"],
          params: EntityIdParams,
          body: EntityMergeBody,
          response: {
            200: Type.Object({ ok: Type.Boolean() }),
            400: Type.Object({ error: Type.String() }),
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const result = await service.mergeEntity(request.params.id, request.body.targetId);
        if (!result.ok) {
          const status = result.error === "entity_not_found" ? 404 : 400;
          return reply.code(status).send(errorOf(result.error));
        }
        return { ok: true };
      },
    );

    app.post(
      "/v1/knowledge/docs/:sourceKind/:sourceId/attach",
      {
        schema: {
          tags: ["knowledge"],
          params: DocSourceParams,
          body: AttachBody,
          response: {
            200: Type.Object({ entityId: Type.String() }),
            400: Type.Object({ error: Type.String() }),
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const result = service.attachDoc({
          sourceKind: request.params.sourceKind,
          sourceId: request.params.sourceId,
          ...(request.body.entityId ? { entityId: request.body.entityId } : {}),
          ...(request.body.createEntity ? { createEntity: request.body.createEntity } : {}),
        });
        if (!result.ok) {
          const status = result.error === "source_not_routed" || result.error === "entity_not_found" ? 404 : 400;
          return reply.code(status).send(errorOf(result.error));
        }
        return { entityId: result.entityId };
      },
    );

    app.get(
      "/v1/knowledge/docs/unmatched",
      {
        schema: {
          tags: ["knowledge"],
          response: {
            200: Type.Object({ items: Type.Array(UnmatchedItemDto) }),
          },
        },
      },
      async () => ({
        items: service.listUnmatched().map((item) => ({
          ...item,
          createdAt: iso(item.createdAt),
        })),
      }),
    );

    app.get(
      "/v1/knowledge/decisions",
      {
        schema: {
          tags: ["knowledge"],
          querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
          response: {
            200: Type.Object({
              items: Type.Array(Type.Object({
                decisionId: Type.String(),
                sourceKind: Type.String(),
                sourceId: Type.String(),
                title: Type.String(),
                roomId: Type.Union([Type.String(), Type.Null()]),
                roomTitle: Type.Union([Type.String(), Type.Null()]),
                decidedBy: Type.Union([Type.String(), Type.Null()]),
                confidence: Type.Number(),
                reason: Type.Union([Type.String(), Type.Null()]),
                status: Type.String(),
                createdAt: Type.String(),
              })),
            }),
          },
        },
      },
      async (request) => ({
        items: service.listRecentDecisions(request.query.limit ?? 20).map((item) => ({
          ...item,
          createdAt: iso(item.createdAt),
        })),
      }),
    );

    app.post(
      "/v1/knowledge/route/:decisionId/revert",
      {
        schema: {
          tags: ["knowledge"],
          params: Type.Object({ decisionId: Type.String({ minLength: 1, maxLength: 100 }) }),
        },
      },
      async (request, reply) => {
        const result = await service.revertDecision(request.params.decisionId);
        if (!result.ok) {
          const status = result.error === "decision_not_found" ? 404 : 400;
          return reply.code(status).send(errorOf(result.error));
        }
        return { ok: true };
      },
    );

    app.post(
      "/v1/knowledge/route/manual",
      {
        schema: {
          tags: ["knowledge"],
          body: ManualRouteBody,
        },
      },
      async (request, reply) => {
        const body = request.body;
        if ("markdown" in body) {
          // 外部信封：只有 router 开启时才被接管（否则无人消费该信封）
          if (!service.routerEnabled) {
            return reply.code(400).send(errorOf("router_disabled"));
          }
          service.submitEnvelope({
            sourceKind: body.sourceKind,
            ...(body.sourceId ? { sourceId: body.sourceId } : {}),
            ...(body.sourceVersion ? { sourceVersion: body.sourceVersion } : {}),
            title: body.title,
            markdown: body.markdown,
            ...(body.occurredAt ? { occurredAt: body.occurredAt } : {}),
            ...(body.entrySignals ? { entrySignals: body.entrySignals } : {}),
          });
          return { queued: true };
        }
        const result = service.routeDocumentNow(body.sourceId);
        if (!result.queued) return reply.code(404).send(errorOf("document_not_found"));
        return { queued: true, roomId: result.roomId };
      },
    );

    app.get(
      "/v1/knowledge/rules",
      {
        schema: {
          tags: ["knowledge"],
          response: {
            200: Type.Object({ items: Type.Array(RuleDto) }),
          },
        },
      },
      async () => ({
        items: service.listRules().map((rule) => ({
          ...rule,
          lastHitAt: rule.lastHitAt ? iso(rule.lastHitAt) : null,
          createdAt: iso(rule.createdAt),
        })),
      }),
    );

    app.post(
      "/v1/knowledge/rules",
      {
        schema: {
          tags: ["knowledge"],
          body: Type.Object({
            matcher: RuleMatcherSchema,
            targetRoomId: Type.String({ minLength: 1, maxLength: 200 }),
          }),
          response: {
            201: Type.Object({ id: Type.String() }),
            400: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const result = service.createRule({
          matcher: request.body.matcher,
          targetRoomId: request.body.targetRoomId,
        });
        if (!result.ok) return reply.code(400).send(errorOf(result.error));
        return reply.code(201).send({ id: result.id });
      },
    );

    app.delete(
      "/v1/knowledge/rules/:id",
      {
        schema: {
          tags: ["knowledge"],
          params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }) }),
        },
      },
      async (request, reply) => {
        const deleted = service.deleteRule(request.params.id);
        if (!deleted) return reply.code(404).send(errorOf("rule_not_found"));
        return reply.code(204).send();
      },
    );
  };
}
