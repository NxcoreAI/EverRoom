import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { WorkspaceInsightService } from "./service.js";

/**
 * 工作空间洞察路由：`GET /v1/agent/workspaces/:workspaceId/insight`。
 *
 * 洞察是派生物：不落库、不产生 404 之外的错误语义——空间没有工作时返回
 * 空会话证据的组合（summary 为空串，advice 为空数组），渲染端按空态处理。
 */
const InsightAdviceDto = Type.Object({
  text: Type.String(),
  /** 建议指向的会话 id；null = 无指向。 */
  sessionId: Type.Union([Type.String(), Type.Null()]),
});

const InsightDto = Type.Object({
  /** 2–3 句状态总结；空间无工作时为空串。 */
  summary: Type.String(),
  advice: Type.Array(InsightAdviceDto),
  /** 产出模型名；null = 模板兜底（确定性聚合）。 */
  model: Type.Union([Type.String(), Type.Null()]),
  /** true = 命中缓存（同指纹 5 分钟内）。 */
  cached: Type.Boolean(),
});

export function workspaceInsightRoutes(service: WorkspaceInsightService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/agent/workspaces/:workspaceId/insight",
      {
        schema: {
          tags: ["agent", "workspace-insight"],
          params: Type.Object({ workspaceId: Type.String({ maxLength: 100 }) }),
          querystring: Type.Object({
            force: Type.Optional(Type.Boolean()),
          }),
          response: { 200: InsightDto },
        },
      },
      async (request) => {
        const { workspaceId } = request.params;
        const force = request.query.force === true;
        return service.get(workspaceId, { force });
      },
    );
  };
}
