import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";

import { WorkspaceActivityError, WorkspaceActivityService } from "./service.js";

/**
 * 工作空间概览「动态」端点。
 *
 * 只读、纯派生：一次请求按 (at, id) 游标返回一页事件，前端「显示更早」再拉下一页。
 * 错误一律 `{ error: code }`（与 plan / agent-scheduler 一致）。
 */

const STATUS_BY_CODE: Record<WorkspaceActivityError["code"], number> = {
  workspace_not_found: 404,
};

function fail(reply: FastifyReply, error: unknown): never {
  if (error instanceof WorkspaceActivityError) {
    const status = STATUS_BY_CODE[error.code] ?? 500;
    reply.code(status).send({ error: error.code, message: error.message });
    throw error;
  }
  throw error;
}

export function workspaceActivityRoutes(service: WorkspaceActivityService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/agent/workspaces/:workspaceId/activities",
      {
        schema: {
          tags: ["agent"],
          params: Type.Object({ workspaceId: Type.String({ minLength: 1, maxLength: 100 }) }),
          querystring: Type.Object({
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
            /** 游标：上一页最后一条的 (at, id)；两者都不传 = 从最新开始。 */
            beforeAt: Type.Optional(Type.String({ maxLength: 40 })),
            beforeId: Type.Optional(Type.String({ maxLength: 200 })),
          }),
        },
      },
      async (request, reply) => {
        // `exactOptionalPropertyTypes`：缺省键不塞 undefined，只把真给了的字段传下去。
        const query: { limit?: number; beforeAt?: string; beforeId?: string } = {};
        if (request.query.limit !== undefined) query.limit = request.query.limit;
        if (request.query.beforeAt !== undefined) query.beforeAt = request.query.beforeAt;
        if (request.query.beforeId !== undefined) query.beforeId = request.query.beforeId;
        try {
          return service.list(request.params.workspaceId, query);
        } catch (error) {
          return fail(reply, error);
        }
      },
    );
  };
}
