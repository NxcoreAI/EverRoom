import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";

import type { PlanActor } from "./service.js";
import { PlanError, PlanService } from "./service.js";
import type { PlanStreamHub } from "./stream.js";

/**
 * 工作空间「计划」（任务 / todo）端点。
 *
 * 约定（与 agent-scheduler 一致）：
 * - 错误一律 `{ error: code }`，HTTP 码由 `PlanError` 的语义决定，渲染层按 code 分支；
 * - 写接口全部带 `version`（乐观锁）；不匹配 → 409，前端刷新后重试；
 * - 用户身份是隐式的（单机单用户后端），Agent 身份由工具侧显式传入（走 service）。
 */

const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }) });

const PlanStatusSchema = Type.Union([
  Type.Literal("todo"),
  Type.Literal("doing"),
  Type.Literal("done"),
  Type.Literal("dropped"),
]);

const PlanPrioritySchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("normal"),
  Type.Literal("high"),
  Type.Literal("urgent"),
]);

const PlanRefSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("file"),
    Type.Literal("document"),
    Type.Literal("session"),
    Type.Literal("url"),
  ]),
  id: Type.String({ minLength: 1, maxLength: 200 }),
  title: Type.String({ maxLength: 200 }),
});

const ChecklistSchema = Type.Object({
  id: Type.Optional(Type.String({ maxLength: 100 })),
  text: Type.String({ minLength: 1, maxLength: 300 }),
  done: Type.Boolean(),
});

const CreateBody = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 100 }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  detail: Type.Optional(Type.Union([Type.String({ maxLength: 20_000 }), Type.Null()])),
  acceptance: Type.Optional(Type.Union([Type.String({ maxLength: 20_000 }), Type.Null()])),
  constraints: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 50 })),
  status: Type.Optional(PlanStatusSchema),
  priority: Type.Optional(PlanPrioritySchema),
  dueAt: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
  tags: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 12 })),
  checklist: Type.Optional(Type.Array(ChecklistSchema, { maxItems: 30 })),
  refs: Type.Optional(Type.Array(PlanRefSchema, { maxItems: 20 })),
  blockedBy: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 })),
});

const UpdateBody = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  detail: Type.Optional(Type.Union([Type.String({ maxLength: 20_000 }), Type.Null()])),
  acceptance: Type.Optional(Type.Union([Type.String({ maxLength: 20_000 }), Type.Null()])),
  constraints: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 50 })),
  priority: Type.Optional(PlanPrioritySchema),
  dueAt: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
  tags: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 12 })),
  checklist: Type.Optional(Type.Array(ChecklistSchema, { maxItems: 30 })),
  refs: Type.Optional(Type.Array(PlanRefSchema, { maxItems: 20 })),
  blockedBy: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 })),
  resultSummary: Type.Optional(Type.Union([Type.String({ maxLength: 20_000 }), Type.Null()])),
  closeReason: Type.Optional(Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()])),
  note: Type.Optional(Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()])),
  ownerKind: Type.Optional(Type.Union([
    Type.Literal("unassigned"),
    Type.Literal("user"),
    Type.Literal("agent"),
  ])),
  ownerAgentId: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
});

const MoveBody = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  status: PlanStatusSchema,
  beforeId: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  afterId: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  reason: Type.Optional(Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()])),
  ownerKind: Type.Optional(Type.Union([
    Type.Literal("unassigned"),
    Type.Literal("user"),
    Type.Literal("agent"),
  ])),
  ownerAgentId: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  resultSummary: Type.Optional(Type.Union([Type.String({ maxLength: 20_000 }), Type.Null()])),
});

const ListQuery = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 100 }),
  status: Type.Optional(PlanStatusSchema),
  owner: Type.Optional(Type.Union([
    Type.Literal("unassigned"),
    Type.Literal("me"),
    Type.Literal("agent"),
  ])),
  q: Type.Optional(Type.String({ maxLength: 200 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

/** `PlanError` → HTTP 码。语义清单与设计文档 §7.1 一致。 */
const STATUS_BY_CODE: Record<string, number> = {
  plan_item_not_found: 404,
  plan_workspace_not_found: 404,
  plan_version_conflict: 409,
  plan_claimed_elsewhere: 409,
  plan_blocked: 409,
  plan_scope_mismatch: 403,
  plan_dependency_cycle: 400,
  plan_invalid_input: 400,
  plan_result_required: 400,
  plan_dispatch_unavailable: 503,
};

function fail(reply: FastifyReply, error: unknown): never {
  if (error instanceof PlanError) {
    const status = STATUS_BY_CODE[error.code] ?? 500;
    reply.code(status).send({ error: error.code, message: error.message, details: error.details });
    throw error;
  }
  throw error;
}

/** 网关里的用户操作（渲染层）：单机单用户，身份就是"用户"。 */
const USER: PlanActor = { kind: "user", id: "user" };

export function planRoutes(service: PlanService, stream: PlanStreamHub): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/plan/items", { schema: { tags: ["plan"], querystring: ListQuery } }, async (request, reply) => {
      try {
        return { items: service.list(request.query) };
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.post("/v1/plan/items", { schema: { tags: ["plan"], body: CreateBody } }, async (request, reply) => {
      try {
        const item = service.create(request.body, USER);
        return reply.code(201).send(item);
      } catch (error) {
        return fail(reply, error);
      }
    });

    /** 批量移动 / 取消（多选卡片后的操作）；单条失败不影响其它条。 */
    app.post(
      "/v1/plan/items/batch",
      {
        schema: {
          tags: ["plan"],
          body: Type.Object({
            ids: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 200 }),
            action: Type.Union([Type.Literal("move"), Type.Literal("drop")]),
            status: Type.Optional(PlanStatusSchema),
          }),
        },
      },
      async (request, reply) => {
        try {
          return service.batch(request.body, USER);
        } catch (error) {
          return fail(reply, error);
        }
      },
    );

    app.get("/v1/plan/items/:id", { schema: { tags: ["plan"], params: IdParams } }, async (request, reply) => {
      try {
        return service.get(request.params.id);
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.get(
      "/v1/plan/items/:id/events",
      { schema: { tags: ["plan"], params: IdParams } },
      async (request, reply) => {
        try {
          return { events: service.events(request.params.id) };
        } catch (error) {
          return fail(reply, error);
        }
      },
    );

    app.get(
      "/v1/plan/items/:id/claim-package",
      { schema: { tags: ["plan"], params: IdParams } },
      async (request, reply) => {
        try {
          return service.claimPackage(request.params.id);
        } catch (error) {
          return fail(reply, error);
        }
      },
    );

    app.patch(
      "/v1/plan/items/:id",
      { schema: { tags: ["plan"], params: IdParams, body: UpdateBody } },
      async (request, reply) => {
        try {
          return service.update(request.params.id, request.body, USER);
        } catch (error) {
          return fail(reply, error);
        }
      },
    );

    app.post(
      "/v1/plan/items/:id/move",
      { schema: { tags: ["plan"], params: IdParams, body: MoveBody } },
      async (request, reply) => {
        try {
          return service.move(request.params.id, request.body, USER);
        } catch (error) {
          return fail(reply, error);
        }
      },
    );

    app.post(
      "/v1/plan/items/:id/release",
      {
        schema: {
          tags: ["plan"],
          params: IdParams,
          body: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 2_000 }) }),
        },
      },
      async (request, reply) => {
        try {
          return service.release(request.params.id, { reason: request.body.reason });
        } catch (error) {
          return fail(reply, error);
        }
      },
    );

    app.post(
      "/v1/plan/items/:id/assign",
      {
        schema: {
          tags: ["plan"],
          params: IdParams,
          body: Type.Object({ agentId: Type.Optional(Type.String({ maxLength: 100 })) }),
        },
      },
      async (request, reply) => {
        try {
          return await service.assign(request.params.id, { agentId: request.body.agentId ?? null }, USER);
        } catch (error) {
          return fail(reply, error);
        }
      },
    );

    /** 删除 = 取消（可恢复）；真删只在清理任务里做。 */
    app.delete("/v1/plan/items/:id", { schema: { tags: ["plan"], params: IdParams } }, async (request, reply) => {
      try {
        return service.remove(request.params.id, USER);
      } catch (error) {
        return fail(reply, error);
      }
    });

    /**
     * 看板实时流（SSE）：agent 认领 / 另一个窗口改状态时，卡片自己动。
     *
     * 只推"哪个空间变了 + 变更后的条目"，不推全量——渲染层按 id upsert，
     * 丢掉一条也不会不一致（下次轮询会补齐）。
     */
    app.get(
      "/v1/plan/stream",
      {
        schema: {
          tags: ["plan"],
          querystring: Type.Object({ workspaceId: Type.String({ minLength: 1, maxLength: 100 }) }),
        },
      },
      async (request, reply) => {
        const { workspaceId } = request.query;
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        reply.raw.write(`event: ready\ndata: {"workspaceId":${JSON.stringify(workspaceId)}}\n\n`);
        const detach = stream.subscribe(workspaceId, (payload) => {
          reply.raw.write(`event: plan\ndata: ${JSON.stringify(payload)}\n\n`);
        });
        const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
        heartbeat.unref?.();
        request.raw.on("close", () => {
          clearInterval(heartbeat);
          detach();
        });
        await new Promise<void>((resolve) => request.raw.on("close", () => resolve()));
      },
    );
  };
}
