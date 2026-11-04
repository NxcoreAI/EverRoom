import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { readProfileView } from "./profile.js";
import type { MemoryService } from "./service.js";

const MemoryHitDto = Type.Object({
  id: Type.String(),
  content: Type.String(),
  tags: Type.Array(Type.String()),
  strength: Type.Number(),
  halfLifeDays: Type.Number(),
  retrievalCount: Type.Integer(),
  createdAt: Type.String(),
  score: Type.Number(),
  /** 记忆层：episodic/semantic（hippo 原始层，整理回合可能把经验合并成 semantic）。 */
  layer: Type.String(),
  /** 对外类别：fact | lesson。**以这个为准**，经验被合并成 semantic 后仍然算 lesson。 */
  category: Type.Union([Type.Literal("fact"), Type.Literal("lesson")]),
  /** 作用域：`workspace:<id>`；null = 全局记忆。 */
  scope: Type.Union([Type.String(), Type.Null()]),
});

const ProfileViewDto = Type.Object({
  /**
   * aggregate=模型聚合出的一版画像；fallback=还没聚合过，按标签把原始事实分组；
   * empty=记忆库为空（或记忆未启用）。
   */
  source: Type.Union([Type.Literal("aggregate"), Type.Literal("fallback"), Type.Literal("empty")]),
  groups: Type.Array(
    Type.Object({
      title: Type.String(),
      items: Type.Array(Type.Object({ id: Type.String(), content: Type.String() })),
    }),
  ),
});

/**
 * 记忆管理端点（桌面端面板/导出用）。
 *
 * 只读 + 删除 + 检索；写入由 agent 工具（memory_remember）与用户显式指令产生，
 * 不开放任意写接口，避免绕过记忆提炼规则。
 */
export function memoryRoutes(service: MemoryService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/memory/status",
      {
        schema: {
          tags: ["memory"],
          response: {
            200: Type.Object({
              enabled: Type.Boolean(),
              started: Type.Boolean(),
              total: Type.Integer(),
              scopes: Type.Record(Type.String(), Type.Integer()),
            }),
          },
        },
      },
      async () => ({
        enabled: service.isEnabled(),
        started: service.isStarted(),
        ...service.stats(),
      }),
    );

    app.get(
      "/v1/memory/entries",
      {
        schema: {
          tags: ["memory"],
          querystring: Type.Object({
            // 上限与适配层的硬上限（MAX_LIMIT=200）对齐：桌面端「智能体」页要一次拿够
            // 全量条目，上限比它小会直接 400，页面就退化成「暂无内容」。
            limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
            scope: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            category: Type.Optional(Type.Union([Type.Literal("fact"), Type.Literal("lesson")])),
          }),
          response: {
            200: Type.Object({ items: Type.Array(MemoryHitDto) }),
          },
        },
      },
      async (request) => ({
        items: service.list({
          limit: request.query.limit,
          ...(request.query.scope !== undefined ? { scope: request.query.scope } : {}),
          ...(request.query.workspaceId !== undefined ? { workspaceId: request.query.workspaceId } : {}),
          ...(request.query.category !== undefined ? { category: request.query.category } : {}),
        }),
      }),
    );

    /**
     * 「用户画像」聚合视图：聚合优先、标签兜底。
     * 分组与词表口径在网关侧（`modules/memory/tags.ts`），桌面端只负责渲染——
     * 口径只能有一份，散到渲染层就会出现「用户交代过但页面不认」的条目。
     */
    app.get(
      "/v1/memory/profile",
      {
        schema: {
          tags: ["memory"],
          querystring: Type.Object({
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          }),
          response: { 200: ProfileViewDto },
        },
      },
      async (request) => readProfileView(
        service,
        request.query.limit !== undefined ? { limit: request.query.limit } : {},
      ),
    );

    app.post(
      "/v1/memory/search",
      {
        schema: {
          tags: ["memory"],
          body: Type.Object({
            query: Type.String({ minLength: 1, maxLength: 500 }),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
            scope: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          }),
          response: {
            200: Type.Object({ items: Type.Array(MemoryHitDto) }),
          },
        },
      },
      async (request) => ({
        items: service.recall({
          query: request.body.query,
          ...(request.body.limit !== undefined ? { limit: request.body.limit } : {}),
          ...(request.body.scope !== undefined ? { scope: request.body.scope } : {}),
        }),
      }),
    );

    app.delete(
      "/v1/memory/entries/:id",
      {
        schema: {
          tags: ["memory"],
          params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }) }),
          response: {
            200: Type.Object({ ok: Type.Boolean() }),
            404: Type.Object({ message: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const ok = service.forget(request.params.id, "user_delete");
        if (!ok) return reply.code(404).send({ message: "memory_not_found" });
        return { ok };
      },
    );
  };
}
