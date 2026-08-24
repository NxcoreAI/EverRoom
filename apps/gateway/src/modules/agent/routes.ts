import { AGENT_PROTOCOL_VERSION } from "@nxcore/agent-contract";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AgentService } from "./service.js";
import type { AgentStatusService } from "./status-service.js";
import { DocumentServiceError } from "../documents/errors.js";

const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }) });
const SessionParams = Type.Object({ sessionId: Type.String({ minLength: 1, maxLength: 100 }) });
const IntentParams = Type.Object({ intentId: Type.String({ minLength: 1, maxLength: 100 }) });
const ResponseLanguage = Type.String({
  minLength: 2,
  maxLength: 35,
  pattern: "^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$",
});
const RoomContextSummary = Type.Object({
  generatedAt: Type.Optional(Type.String({ maxLength: 40 })),
  overview: Type.String({ maxLength: 500 }),
  nextSteps: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 4 }),
  entities: Type.Array(Type.Object({
    name: Type.String({ maxLength: 120 }),
    kind: Type.String({ maxLength: 24 }),
    description: Type.String({ maxLength: 300 }),
  }), { maxItems: 10 }),
  actionItems: Type.Array(Type.Object({
    title: Type.String({ maxLength: 300 }),
    owner: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
    dueDate: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
    sourceTitle: Type.String({ maxLength: 300 }),
  }), { maxItems: 10 }),
  meetings: Type.Array(Type.Object({
    title: Type.String({ maxLength: 300 }),
    when: Type.String({ maxLength: 120 }),
    participants: Type.Array(Type.String({ maxLength: 120 }), { maxItems: 20 }),
    sourceTitle: Type.String({ maxLength: 300 }),
  }), { maxItems: 10 }),
  sourceDocuments: Type.Array(Type.Object({
    documentId: Type.String({ maxLength: 200 }),
    title: Type.String({ maxLength: 300 }),
    version: Type.Integer({ minimum: 0 }),
    updatedAt: Type.String({ maxLength: 40 }),
  }), { maxItems: 20 }),
});
const RemoteCommandBody = Type.Object({
  commandId: Type.String({ minLength: 1, maxLength: 100 }),
  idempotencyKey: Type.String({ minLength: 8, maxLength: 100 }),
  prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
  title: Type.Optional(Type.String({ maxLength: 160 })),
});
const NavigationTarget = Type.Object({
  pageId: Type.String({ minLength: 1, maxLength: 40 }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  action: Type.Union([
    Type.Literal("created"),
    Type.Literal("updated"),
    Type.Literal("opened"),
    Type.Literal("referenced"),
  ]),
  roomId: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  objectId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  blockId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  objectType: Type.Optional(Type.Union([
    Type.Literal("room"),
    Type.Literal("document"),
    Type.Literal("source"),
    Type.Literal("memory"),
    Type.Literal("task"),
    Type.Literal("diary"),
  ])),
});

export function agentRoutes(
  service: AgentService,
  statusService?: AgentStatusService,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    if (statusService) {
      app.get(
        "/v1/agent/status",
        { schema: { tags: ["agent"] } },
        async () => statusService.snapshot(),
      );
    }
    app.get(
      "/v1/agent/usage",
      {
        schema: {
          tags: ["agent"],
          querystring: Type.Object({
            range: Type.Optional(Type.Union([Type.Literal("24h"), Type.Literal("7d"), Type.Literal("30d")])),
          }),
        },
      },
      async (request) => service.getUsage(request.query.range ?? "7d"),
    );
    app.get(
      "/v1/agent/sessions",
      {
        schema: {
          tags: ["agent"],
          querystring: Type.Object({
            pageLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            roomId: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
          }),
        },
      },
      async (request) => service.listSessions(request.query.pageLabel, request.query.roomId),
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

    app.post(
      "/v1/agent/remote/commands",
      { schema: { tags: ["agent"], body: RemoteCommandBody } },
      async (request, reply) => {
        try {
          return reply.code(202).send(await service.startRemoteRun(request.body));
        } catch (error) {
          if (error instanceof Error && error.message === "agent_session_busy") {
            return reply.code(409).send({ error: "session_busy", message: "Remote Agent already has an active run" });
          }
          throw error;
        }
      },
    );

    app.post(
      "/v1/agent/remote/commands/:id/cancel",
      { schema: { tags: ["agent"], params: IdParams, body: Type.Object({
        runId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      }) } },
      async (request, reply) => reply.code(200).send(await service.cancelRemoteRun(request.params.id, request.body.runId, request.body.sessionId)),
    );

    app.post(
      "/v1/agent/session-links",
      {
        schema: {
          tags: ["agent"],
          body: Type.Object({
            sourceSessionId: Type.String({ minLength: 1, maxLength: 100 }),
            targetSessionId: Type.String({ minLength: 1, maxLength: 100 }),
            sourceRunId: Type.String({ minLength: 1, maxLength: 100 }),
            sourcePageId: Type.String({ minLength: 1, maxLength: 40 }),
            sourcePageLabel: Type.String({ minLength: 1, maxLength: 120 }),
            sourceRoomId: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
            target: NavigationTarget,
          }),
        },
      },
      async (request, reply) => {
        try {
          return reply.code(201).send(service.createSessionLink(request.body));
        } catch (error) {
          if (error instanceof Error && error.message === "agent_session_link_target_not_found") {
            return reply.code(404).send({ error: "not_found", message: "Linked Agent session or run not found" });
          }
          if (error instanceof Error && error.message === "agent_session_link_invalid_target") {
            return reply.code(400).send({ error: "invalid_target", message: "Agent navigation target is invalid" });
          }
          throw error;
        }
      },
    );

    app.get(
      "/v1/agent/sessions/:sessionId/links",
      { schema: { tags: ["agent"], params: SessionParams } },
      async (request) => service.listSessionLinks(request.params.sessionId),
    );

    app.post(
      "/v1/agent/session-links/:id/return",
      { schema: { tags: ["agent"], params: IdParams } },
      async (request, reply) => service.markSessionLinkReturned(request.params.id)
        ?? reply.code(404).send({ error: "not_found", message: "Agent session link not found" }),
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
            prompt: Type.String({ maxLength: 20_000 }),
            idempotencyKey: Type.String({ minLength: 8, maxLength: 100 }),
            attachments: Type.Optional(Type.Array(Type.Object({
              fileId: Type.String({ minLength: 1, maxLength: 200 }),
              filename: Type.String({ minLength: 1, maxLength: 255 }),
              mimeType: Type.String({ minLength: 1, maxLength: 120 }),
              size: Type.Integer({ minimum: 1, maximum: 10 * 1024 * 1024 }),
              kind: Type.Union([Type.Literal("document"), Type.Literal("image")]),
            }), { maxItems: 5 })),
            replaceRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            responseLanguage: Type.Optional(ResponseLanguage),
            captureMemory: Type.Optional(Type.Boolean()),
            recallMemory: Type.Optional(Type.Boolean()),
            toolsEnabled: Type.Optional(Type.Boolean()),
            context: Type.Optional(Type.Object({
              pageLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
              selectedText: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
              rooms: Type.Optional(Type.Array(Type.Object({
                id: Type.String({ minLength: 1, maxLength: 100 }),
                title: Type.String({ minLength: 1, maxLength: 120 }),
                kind: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
              }), { maxItems: 200 })),
              selectedRoomId: Type.Optional(Type.Union([
                Type.String({ minLength: 1, maxLength: 100 }),
                Type.Null(),
              ])),
              activeDocument: Type.Optional(Type.Object({
                roomId: Type.String({ minLength: 1, maxLength: 128 }),
                documentId: Type.String({ minLength: 1, maxLength: 128 }),
                title: Type.String({ minLength: 1, maxLength: 120 }),
                version: Type.Integer({ minimum: 0 }),
                defaultAnchor: Type.Literal("end"),
                cursorAnchorCandidate: Type.Optional(Type.Object({
                  blockId: Type.String({ minLength: 1, maxLength: 128 }),
                  offset: Type.Integer({ minimum: 0 }),
                  affinity: Type.Literal("after"),
                })),
              })),
            })),
          }),
        },
      },
      async (request, reply) => {
        try {
          return reply.code(202).send(await service.startRun(request.params.sessionId, request.body));
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send({
              error: error.code,
              message: error.message,
              ...error.details,
            });
          }
          if (error instanceof Error && error.message === "agent_session_not_found") {
            return reply.code(404).send({ error: "not_found", message: "Agent session not found" });
          }
          if (error instanceof Error && error.message === "agent_session_busy") {
            return reply.code(409).send({ error: "session_busy", message: "Agent session already has an active run" });
          }
          if (error instanceof Error && error.message === "agent_replace_run_not_found") {
            return reply.code(404).send({ error: "replace_run_not_found", message: "Agent run to regenerate was not found" });
          }
          if (error instanceof Error && error.message === "agent_replace_run_active") {
            return reply.code(409).send({ error: "replace_run_active", message: "An active Agent run cannot be regenerated" });
          }
          if (error instanceof Error && error.message === "agent_room_not_available") {
            return reply.code(409).send({
              error: "room_not_available",
              message: "The selected Context Room is no longer available",
            });
          }
          throw error;
        }
      },
    );

    app.get(
      "/v1/agent/sessions/:sessionId/pending-intents",
      { schema: { tags: ["agent"], params: SessionParams } },
      async (request) => service.listPendingIntents(request.params.sessionId),
    );

    app.post(
      "/v1/agent/sessions/:sessionId/pending-intents",
      {
        schema: {
          tags: ["agent"],
          params: SessionParams,
          body: Type.Object({
            sourceRunId: Type.String({ minLength: 1, maxLength: 100 }),
            targetCapability: Type.Union([
              Type.Literal("document.create"),
              Type.Literal("document.edit"),
              Type.Literal("document.continue"),
            ]),
            allowedRoomIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 200 }),
            allowedDocumentIds: Type.Optional(Type.Array(
              Type.String({ minLength: 1, maxLength: 128 }),
              { maxItems: 500 },
            )),
          }),
        },
      },
      async (request, reply) => {
        try {
          return reply.code(201).send(service.preparePendingIntent({
            sessionId: request.params.sessionId,
            ...request.body,
          }));
        } catch (error) {
          if (error instanceof Error && error.message === "pending_agent_intent_source_not_found") {
            return reply.code(404).send({ error: "not_found", message: "Source Agent run not found" });
          }
          if (error instanceof Error && (
            error.message === "pending_agent_intent_resource_not_allowed"
            || error.message === "pending_agent_intent_resource_required"
          )) {
            return reply.code(409).send({ error: "resource_not_allowed", message: "Pending intent resource is unavailable" });
          }
          throw error;
        }
      },
    );

    app.post(
      "/v1/agent/pending-intents/:intentId/submit",
      {
        schema: {
          tags: ["agent"],
          params: IntentParams,
          body: Type.Object({
            roomId: Type.String({ minLength: 1, maxLength: 100 }),
            documentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            idempotencyKey: Type.String({ minLength: 8, maxLength: 100 }),
            responseLanguage: Type.Optional(ResponseLanguage),
          }),
        },
      },
      async (request, reply) => {
        try {
          return reply.code(202).send(await service.submitPendingIntent(request.params.intentId, request.body));
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (code === "pending_agent_intent_not_found") {
            return reply.code(404).send({ error: "not_found", message: "Pending Agent intent not found" });
          }
          if (code === "pending_agent_intent_consumed" || code === "pending_agent_intent_expired") {
            return reply.code(409).send({ error: code, message: "Pending Agent intent is no longer available" });
          }
          if (code === "pending_agent_intent_resource_not_allowed" || code === "pending_agent_intent_resource_required") {
            return reply.code(409).send({ error: code, message: "Selected resource is not allowed" });
          }
          if (code === "agent_session_busy") {
            return reply.code(409).send({ error: "session_busy", message: "Agent session already has an active run" });
          }
          if (code === "pending_agent_intent_idempotency_conflict") {
            return reply.code(409).send({ error: code, message: "Idempotency key already belongs to another Agent run" });
          }
          throw error;
        }
      },
    );

    app.post(
      "/v1/agent/mcp-sessions",
      {
        schema: {
          tags: ["agent", "mcp"],
          body: Type.Object({
            agentSessionId: Type.String({ minLength: 1, maxLength: 128 }),
            runId: Type.String({ minLength: 1, maxLength: 128 }),
            roomId: Type.String({ minLength: 1, maxLength: 128 }),
          }),
        },
      },
      async (request, reply) => {
        try {
          return reply.code(201).send(service.createTrustedMcpSession(
            request.body.agentSessionId,
            request.body.runId,
            request.body.roomId,
          ));
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (code === "mcp_agent_context_not_found") {
            return reply.code(404).send({ error: "not_found", message: "Agent MCP context not found" });
          }
          if (
            code === "mcp_agent_room_not_available"
            || code === "mcp_agent_context_mismatch"
            || code === "mcp_agent_context_not_active"
          ) {
            return reply.code(409).send({ error: code, message: "Agent MCP context is not valid" });
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
