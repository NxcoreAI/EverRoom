import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AgentDebugService } from "./service.js";

/**
 * Agent 调试面板 REST（只读）：按 Agent 展示运行时实际装配的上下文。
 * 走网关全局 bearer（仅桌面端调用），不额外做鉴权。
 */

const AgentIdParams = Type.Object({
  agentId: Type.String({ minLength: 1, maxLength: 100 }),
});

const UsageQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const DEFAULT_USAGE_LIMIT = 20;

export function agentDebugRoutes(service: AgentDebugService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/agent-debug/agents",
      { schema: { tags: ["agent"] } },
      async () => service.listAgents(),
    );

    app.get(
      "/v1/agent-debug/agents/:agentId/usage",
      { schema: { tags: ["agent"], params: AgentIdParams, querystring: UsageQuery } },
      async (request, reply) => {
        const response = await service.usage(
          request.params.agentId,
          request.query.limit ?? DEFAULT_USAGE_LIMIT,
        );
        if (!response) {
          return reply.code(404).send({
            error: "not_found",
            message: `Unknown Agent: ${request.params.agentId}`,
          });
        }
        return response;
      },
    );

    app.get(
      "/v1/agent-debug/agents/:agentId",
      { schema: { tags: ["agent"], params: AgentIdParams } },
      async (request, reply) => {
        const response = await service.getAgent(request.params.agentId);
        if (!response) {
          return reply.code(404).send({
            error: "not_found",
            message: `Unknown Agent: ${request.params.agentId}`,
          });
        }
        return response;
      },
    );
  };
}