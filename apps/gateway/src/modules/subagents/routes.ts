import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { SubagentOrchestrator } from "./orchestrator.js";

export function subagentRoutes(orchestrator: SubagentOrchestrator): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/subagents", {
      schema: { tags: ["subagents"] },
    }, async () => orchestrator.listDefinitions());

    app.get("/v1/subagent-invocations", {
      schema: {
        tags: ["subagents"],
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
          // 传 rootRunId 时返回该 run 的子代理调用树（含嵌套后代），忽略 limit。
          rootRunId: Type.Optional(Type.String({ minLength: 1 })),
        }),
      },
    }, async (request) => request.query.rootRunId
      ? orchestrator.listInvocationTree(request.query.rootRunId)
      : orchestrator.listInvocations(request.query.limit));

    app.get("/v1/subagent-invocations/:invocationId", {
      schema: {
        tags: ["subagents"],
        params: Type.Object({ invocationId: Type.String({ minLength: 1 }) }),
      },
    }, async (request, reply) => {
      const invocation = orchestrator.getInvocation(request.params.invocationId);
      return invocation ?? reply.code(404).send({ message: "subagent_invocation_not_found" });
    });

    app.get("/v1/subagent-invocations/:invocationId/events", {
      schema: {
        tags: ["subagents"],
        params: Type.Object({ invocationId: Type.String({ minLength: 1 }) }),
        querystring: Type.Object({
          afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
      },
    }, async (request) => orchestrator.listInvocationEvents(
      request.params.invocationId,
      request.query.afterSeq ?? 0,
    ));

    app.post("/v1/subagent-invocations/:invocationId/cancel", {
      schema: {
        tags: ["subagents"],
        params: Type.Object({ invocationId: Type.String({ minLength: 1 }) }),
      },
    }, async (request, reply) => {
      const invocation = await orchestrator.cancel(request.params.invocationId);
      return invocation ?? reply.code(404).send({ message: "subagent_invocation_not_found" });
    });
  };
}
