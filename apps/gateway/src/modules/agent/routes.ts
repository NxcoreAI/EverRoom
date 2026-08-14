import { AGENT_PROTOCOL_VERSION } from "@nxcore/agent-contract";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AgentService } from "./service.js";

const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }) });
const SessionParams = Type.Object({ sessionId: Type.String({ minLength: 1, maxLength: 100 }) });

export function agentRoutes(service: AgentService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/agent/sessions",
      {
        schema: {
          tags: ["agent"],
          querystring: Type.Object({
            pageLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          }),
        },
      },
      async (request) => service.listSessions(request.query.pageLabel),
    );

    app.post(
      "/v1/agent/sessions",
      {
        schema: {
          tags: ["agent"],
          body: Type.Object({
            pageLabel: Type.String({ minLength: 1, maxLength: 120 }),
            roomId: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
          }),
        },
      },
      async (request, reply) => reply.code(201).send(service.createSession(request.body)),
    );

    app.get(
      "/v1/agent/sessions/:sessionId",
      { schema: { tags: ["agent"], params: SessionParams } },
      async (request, reply) => {
        const snapshot = service.getSnapshot(request.params.sessionId);
        return snapshot ?? reply.code(404).send({ error: "not_found", message: "Agent session not found" });
      },
    );

    app.patch(
      "/v1/agent/sessions/:sessionId",
      {
        schema: {
          tags: ["agent"],
          params: SessionParams,
          body: Type.Object({ title: Type.String({ minLength: 1, maxLength: 120 }) }),
        },
      },
      async (request, reply) => service.updateSession(request.params.sessionId, request.body)
        ?? reply.code(404).send({ error: "not_found", message: "Agent session not found" }),
    );

    app.delete(
      "/v1/agent/sessions/:sessionId",
      { schema: { tags: ["agent"], params: SessionParams } },
      async (request, reply) => {
        try {
          const deleted = await service.deleteSession(request.params.sessionId);
          return deleted
            ? reply.code(204).send()
            : reply.code(404).send({ error: "not_found", message: "Agent session not found" });
        } catch (error) {
          if (error instanceof Error && error.message === "agent_session_busy") {
            return reply.code(409).send({ error: "session_busy", message: "Running agent sessions cannot be deleted" });
          }
          throw error;
        }
      },
    );

    app.get(
      "/v1/agent/sessions/:sessionId/events",
      {
        schema: {
          tags: ["agent"],
          params: SessionParams,
          querystring: Type.Object({
            runId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
          }),
        },
      },
      async (request) =>
        service.listEvents(request.params.sessionId, request.query.runId, request.query.afterSeq ?? 0),
    );

    app.post(
      "/v1/agent/sessions/:sessionId/runs",
      {
        schema: {
          tags: ["agent"],
          params: SessionParams,
          body: Type.Object({
            prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
            idempotencyKey: Type.String({ minLength: 8, maxLength: 100 }),
          }),
        },
      },
      async (request, reply) => {
        try {
          return reply.code(202).send(await service.startRun(request.params.sessionId, request.body));
        } catch (error) {
          if (error instanceof Error && error.message === "agent_session_not_found") {
            return reply.code(404).send({ error: "not_found", message: "Agent session not found" });
          }
          if (error instanceof Error && error.message === "agent_session_busy") {
            return reply.code(409).send({ error: "session_busy", message: "Agent session already has an active run" });
          }
          throw error;
        }
      },
    );

    app.get(
      "/v1/agent/runs/:id",
      { schema: { tags: ["agent"], params: IdParams } },
      async (request, reply) =>
        service.getRun(request.params.id) ?? reply.code(404).send({ error: "not_found", message: "Agent run not found" }),
    );

    app.post(
      "/v1/agent/runs/:id/cancel",
      { schema: { tags: ["agent"], params: IdParams } },
      async (request, reply) => {
        const run = await service.cancelRun(request.params.id);
        return run ?? reply.code(404).send({ error: "not_found", message: "Agent run not found" });
      },
    );

    app.get(
      "/v1/agent/sessions/:sessionId/stream",
      { websocket: true },
      (socket, request) => {
        const sessionId = (request.params as { sessionId?: string }).sessionId;
        if (!sessionId) {
          socket.close(1008, "Missing session id");
          return;
        }
        const snapshot = service.getSnapshot(sessionId);
        if (!snapshot) {
          socket.close(1008, "Agent session not found");
          return;
        }
        const unsubscribe = service.broker.subscribe(sessionId, socket);
        socket.send(JSON.stringify({
          type: "ready",
          protocol: AGENT_PROTOCOL_VERSION,
          sessionId,
          lastEventSeq: snapshot.lastEventSeq,
        }));
        socket.once("close", unsubscribe);
      },
    );
  };
}
