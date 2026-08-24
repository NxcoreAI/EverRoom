import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AgentSchedulerService } from "./service.js";

const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }) });
const CreateBody = Type.Object({
  agentId: Type.String({ minLength: 1, maxLength: 100 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 1_000 })),
  prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
  localTime: Type.Optional(Type.String()),
  timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  enabled: Type.Optional(Type.Boolean()),
});

export function agentSchedulerRoutes(service: AgentSchedulerService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/agent/schedules", { schema: { tags: ["agent-scheduler"] } }, async () => service.list());
    app.post("/v1/agent/schedules", { schema: { tags: ["agent-scheduler"], body: CreateBody } }, async (request, reply) => {
      try { return reply.code(201).send(service.create(request.body)); }
      catch (error) {
        if (error instanceof Error && error.message.startsWith("agent_schedule_invalid")) return reply.code(400).send({ error: error.message });
        throw error;
      }
    });
    app.patch(
      "/v1/agent/schedules/:id",
      {
        schema: {
          tags: ["agent-scheduler"],
          params: IdParams,
          body: Type.Object({
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            description: Type.Optional(Type.String({ maxLength: 1_000 })),
            prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
            enabled: Type.Optional(Type.Boolean()),
            localTime: Type.Optional(Type.String()),
            timezone: Type.Optional(Type.String()),
            configVersion: Type.Integer({ minimum: 1 }),
          }),
        },
      },
      async (request, reply) => {
        try { return service.update(request.params.id, request.body); }
        catch (error) {
          if (error instanceof Error && error.message === "agent_schedule_not_found") return reply.code(404).send({ error: "not_found" });
          if (error instanceof Error && error.message === "agent_schedule_builtin") return reply.code(409).send({ error: "builtin_schedule" });
          if (error instanceof Error && error.message === "agent_schedule_conflict") return reply.code(409).send({ error: "config_conflict" });
          throw error;
        }
      },
    );
    app.delete("/v1/agent/schedules/:id", { schema: { tags: ["agent-scheduler"], params: IdParams } }, async (request, reply) => {
      try { service.remove(request.params.id); return reply.code(204).send(); }
      catch (error) {
        if (error instanceof Error && error.message === "agent_schedule_not_found") return reply.code(404).send({ error: "not_found" });
        if (error instanceof Error && error.message === "agent_schedule_builtin") return reply.code(409).send({ error: "builtin_schedule" });
        throw error;
      }
    });
    app.post(
      "/v1/agent/schedules/:id/run",
      { schema: { tags: ["agent-scheduler"], params: IdParams } },
      async (request, reply) => {
        try { return reply.code(202).send(await service.runNow(request.params.id)); }
        catch (error) {
          if (error instanceof Error && error.message === "agent_schedule_not_found") return reply.code(404).send({ error: "not_found" });
          throw error;
        }
      },
    );
  };
}
