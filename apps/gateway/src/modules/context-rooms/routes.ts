import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { ContextRoomService } from "./service.js";
import { DuplicateReviewRequiredError, type RoomDuplicateService } from "./duplicate-service.js";
import type { RoomAgentDispatcher } from "./room-agent.js";
import type { RoomOverviewService } from "./overview-service.js";

const RoomData = Type.Object({}, { additionalProperties: true });
const RoomSnapshotItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  title: Type.String({ minLength: 1, maxLength: 120 }),
  kind: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  data: RoomData,
});
const OverviewSection = Type.Union([
  Type.Literal("overview"), Type.Literal("status"), Type.Literal("next_steps"),
  Type.Literal("timeline"), Type.Literal("entities"),
]);
const CorrectionOperation = Type.Union([
  Type.Literal("content_replace"), Type.Literal("content_add"), Type.Literal("content_suppress"),
  Type.Literal("fact_correct"), Type.Literal("fact_add"), Type.Literal("source_remove"),
  Type.Literal("source_reassign"),
]);

export function contextRoomRoutes(
  service: ContextRoomService,
  duplicates?: RoomDuplicateService,
  roomAgent?: RoomAgentDispatcher,
  overviews?: RoomOverviewService,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/context-rooms",
      { schema: { tags: ["context-rooms"] } },
      async () => service.getSnapshot(),
    );

    app.post(
      "/v1/context-rooms",
      {
        schema: {
          tags: ["context-rooms"],
          body: Type.Object({
            title: Type.String({ minLength: 1, maxLength: 120 }),
            description: Type.String({ minLength: 1, maxLength: 2_000 }),
            duplicateOverrideToken: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          }, { additionalProperties: false }),
        },
      },
      async (request, reply) => {
        try {
          return await service.createRoom(request.body);
        } catch (error) {
          if (error instanceof DuplicateReviewRequiredError) {
            return reply.code(409).send({
              error: error.code,
              message: error.message,
              ...error.result,
            });
          }
          if (error instanceof Error && (
            error.message === "context_room_title_required"
            || error.message === "context_room_description_required"
          )) {
            return reply.code(400).send({
              error: "invalid_room",
              message: "Context Room title and description cannot be blank",
            });
          }
          throw error;
        }
      },
    );

    app.put(
      "/v1/context-rooms/snapshot",
      {
        schema: {
          tags: ["context-rooms"],
          body: Type.Object({
            rooms: Type.Array(RoomSnapshotItem, { maxItems: 500 }),
            deletedRooms: Type.Array(RoomSnapshotItem, { maxItems: 500 }),
          }),
        },
      },
      async (request, reply) => {
        try {
          return service.saveSnapshot(request.body);
        } catch (error) {
          if (error instanceof Error && error.message === "context_room_snapshot_has_duplicate_ids") {
            return reply.code(409).send({
              error: "duplicate_room_ids",
              message: "A Context Room cannot appear more than once in a snapshot",
            });
          }
          if (error instanceof Error && error.message === "context_room_snapshot_has_invalid_room") {
            return reply.code(400).send({
              error: "invalid_room",
              message: "Context Room ids and titles cannot be blank",
            });
          }
          throw error;
        }
      },
    );

    app.post(
      "/v1/context-rooms/duplicate-check",
      {
        schema: {
          tags: ["context-rooms"],
          body: Type.Object({
            title: Type.String({ minLength: 1, maxLength: 120 }),
            description: Type.Optional(Type.String({ maxLength: 2_000 })),
            kind: Type.Optional(Type.String({ maxLength: 40 })),
            excludeRoomId: Type.Optional(Type.String({ maxLength: 128 })),
          }, { additionalProperties: false }),
        },
      },
      async (request, reply) => duplicates
        ? duplicates.checkCreation(request.body)
        : reply.code(503).send({ error: "room_duplicate_service_unavailable" }),
    );

    app.get(
      "/v1/context-rooms/duplicate-candidates",
      {
        schema: {
          tags: ["context-rooms"],
          querystring: Type.Object({
            status: Type.Optional(Type.Union([
              Type.Literal("open"), Type.Literal("related"), Type.Literal("distinct"), Type.Literal("merged"),
            ])),
          }),
        },
      },
      async (request, reply) => duplicates
        ? { items: duplicates.listCandidates(request.query.status) }
        : reply.code(503).send({ error: "room_duplicate_service_unavailable" }),
    );

    app.patch(
      "/v1/context-rooms/duplicate-candidates/:id",
      {
        schema: {
          tags: ["context-rooms"],
          params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }),
          body: Type.Object({ status: Type.Union([Type.Literal("related"), Type.Literal("distinct")]) }),
        },
      },
      async (request, reply) => {
        const candidate = duplicates?.updateCandidate(request.params.id, request.body.status);
        return candidate ?? reply.code(404).send({ error: "room_duplicate_candidate_not_found" });
      },
    );

    app.post(
      "/v1/context-rooms/merge-preview",
      {
        schema: {
          tags: ["context-rooms"],
          body: Type.Object({
            sourceRoomId: Type.String({ minLength: 1, maxLength: 128 }),
            targetRoomId: Type.String({ minLength: 1, maxLength: 128 }),
          }),
        },
      },
      async (request, reply) => {
        if (!duplicates) return reply.code(503).send({ error: "room_duplicate_service_unavailable" });
        try {
          return await duplicates.previewMerge(request.body.sourceRoomId, request.body.targetRoomId);
        } catch (error) {
          const code = error instanceof Error ? error.message : "context_room_merge_preview_failed";
          return reply.code(code === "context_room_not_mergeable" ? 404 : 409).send({ error: code });
        }
      },
    );

    app.post(
      "/v1/context-rooms/merge-operations",
      {
        schema: {
          tags: ["context-rooms"],
          body: Type.Object({
            sourceRoomId: Type.String({ minLength: 1, maxLength: 128 }),
            targetRoomId: Type.String({ minLength: 1, maxLength: 128 }),
            previewHash: Type.String({ minLength: 64, maxLength: 64 }),
            idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
          }),
        },
      },
      async (request, reply) => {
        if (!duplicates) return reply.code(503).send({ error: "room_duplicate_service_unavailable" });
        try {
          return await duplicates.startMerge(request.body);
        } catch (error) {
          return reply.code(409).send({ error: error instanceof Error ? error.message : "context_room_merge_failed" });
        }
      },
    );

    app.get(
      "/v1/context-rooms/merge-operations/:id",
      {
        schema: {
          tags: ["context-rooms"],
          params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }),
        },
      },
      async (request, reply) => duplicates?.getOperation(request.params.id)
        ?? reply.code(404).send({ error: "context_room_merge_not_found" }),
    );

    app.post(
      "/v1/context-rooms/merge-operations/:id/retry",
      {
        schema: { tags: ["context-rooms"], params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }) },
      },
      async (request, reply) => duplicates?.retryMerge(request.params.id)
        ?? reply.code(404).send({ error: "context_room_merge_not_found" }),
    );

    app.post(
      "/v1/context-rooms/merge-operations/:id/cancel",
      {
        schema: { tags: ["context-rooms"], params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }) },
      },
      async (request, reply) => {
        try {
          return duplicates?.cancelMerge(request.params.id)
            ?? reply.code(404).send({ error: "context_room_merge_not_found" });
        } catch (error) {
          return reply.code(409).send({ error: error instanceof Error ? error.message : "context_room_merge_cannot_cancel" });
        }
      },
    );

    app.post(
      "/v1/context-rooms/:roomId/refresh-brief",
      {
        schema: {
          tags: ["context-rooms"],
          params: Type.Object({ roomId: Type.String({ minLength: 1, maxLength: 128 }) }),
        },
      },
      async (request, reply) => {
        try {
          return await service.refreshBrief(request.params.roomId);
        } catch (error) {
          const code = error instanceof Error ? error.message : "context_room_brief_refresh_failed";
          if (code === "context_room_not_found") {
            return reply.code(404).send({ error: code, message: "Context Room not found" });
          }
          if (code === "context_room_agent_not_configured") {
            return reply.code(503).send({ error: code, message: "Context Room agent is not available" });
          }
          return reply.code(502).send({ error: code, message: "Context Room brief refresh failed" });
        }
      },
    );

    app.get(
      "/v1/context-rooms/:roomId/overview",
      {
        schema: {
          tags: ["context-rooms"],
          params: Type.Object({ roomId: Type.String({ minLength: 1, maxLength: 128 }) }),
        },
      },
      async (request, reply) => {
        if (!overviews) return reply.code(503).send({ error: "room_overview_service_unavailable" });
        try {
          return overviews.get(request.params.roomId);
        } catch (error) {
          if (error instanceof Error && error.message === "context_room_not_found") {
            return reply.code(404).send({ error: error.message });
          }
          throw error;
        }
      },
    );

    app.post(
      "/v1/context-rooms/:roomId/overview/refresh",
      {
        schema: {
          tags: ["context-rooms"],
          params: Type.Object({ roomId: Type.String({ minLength: 1, maxLength: 128 }) }),
        },
      },
      async (request, reply) => {
        if (!overviews) return reply.code(503).send({ error: "room_overview_service_unavailable" });
        try {
          return await overviews.regenerate(request.params.roomId);
        } catch (error) {
          if (error instanceof Error && error.message === "context_room_not_found") {
            return reply.code(404).send({ error: error.message });
          }
          throw error;
        }
      },
    );

    app.get(
      "/v1/context-rooms/:roomId/corrections",
      {
        schema: {
          tags: ["context-rooms"],
          params: Type.Object({ roomId: Type.String({ minLength: 1, maxLength: 128 }) }),
        },
      },
      async (request, reply) => overviews
        ? { items: overviews.list(request.params.roomId) }
        : reply.code(503).send({ error: "room_overview_service_unavailable" }),
    );

    app.post(
      "/v1/context-rooms/:roomId/correction-proposals",
      {
        schema: {
          tags: ["context-rooms"],
          params: Type.Object({ roomId: Type.String({ minLength: 1, maxLength: 128 }) }),
          body: Type.Object({
            operation: CorrectionOperation,
            section: OverviewSection,
            targetClaimId: Type.Optional(Type.String({ maxLength: 200 })),
            targetSource: Type.Optional(Type.Object({
              sourceKind: Type.String({ minLength: 1, maxLength: 100 }),
              sourceId: Type.String({ minLength: 1, maxLength: 256 }),
              sourceTitle: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
            }, { additionalProperties: false })),
            targetRoomId: Type.Optional(Type.String({ maxLength: 128 })),
            originalText: Type.Optional(Type.String({ maxLength: 4_000 })),
            replacementText: Type.Optional(Type.String({ maxLength: 4_000 })),
            rationale: Type.String({ minLength: 1, maxLength: 2_000 }),
            entryPoint: Type.Union([Type.Literal("overview"), Type.Literal("section"), Type.Literal("agent")]),
            sessionId: Type.Optional(Type.String({ maxLength: 200 })),
          }, { additionalProperties: false }),
        },
      },
      async (request, reply) => {
        if (!overviews) return reply.code(503).send({ error: "room_overview_service_unavailable" });
        try {
          return overviews.propose(request.params.roomId, request.body);
        } catch (error) {
          const code = error instanceof Error ? error.message : "room_correction_invalid";
          return reply.code(code === "context_room_not_found" ? 404 : 400).send({ error: code });
        }
      },
    );

    app.post(
      "/v1/context-rooms/:roomId/correction-proposals/:proposalId/apply",
      {
        schema: {
          tags: ["context-rooms"],
          params: Type.Object({
            roomId: Type.String({ minLength: 1, maxLength: 128 }),
            proposalId: Type.String({ minLength: 1, maxLength: 200 }),
          }),
        },
      },
      async (request, reply) => {
        if (!overviews) return reply.code(503).send({ error: "room_overview_service_unavailable" });
        try {
          return overviews.apply(request.params.roomId, request.params.proposalId);
        } catch (error) {
          return reply.code(409).send({ error: error instanceof Error ? error.message : "room_correction_apply_failed" });
        }
      },
    );

    app.post(
      "/v1/context-rooms/:roomId/corrections/:correctionId/revoke",
      {
        schema: {
          tags: ["context-rooms"],
          params: Type.Object({
            roomId: Type.String({ minLength: 1, maxLength: 128 }),
            correctionId: Type.String({ minLength: 1, maxLength: 200 }),
          }),
        },
      },
      async (request, reply) => {
        if (!overviews) return reply.code(503).send({ error: "room_overview_service_unavailable" });
        try {
          return overviews.revoke(request.params.roomId, request.params.correctionId);
        } catch (error) {
          return reply.code(409).send({ error: error instanceof Error ? error.message : "room_correction_revoke_failed" });
        }
      },
    );

    app.get(
      "/v1/context-rooms/:roomId/entities",
      {
        schema: {
          tags: ["context-rooms"],
          params: Type.Object({ roomId: Type.String({ minLength: 1, maxLength: 128 }) }),
        },
      },
      async (request, reply) => {
        try {
          return service.roomAppliedEntities(request.params.roomId);
        } catch (error) {
          if (error instanceof Error && error.message === "context_room_not_found") {
            return reply.code(404).send({ error: error.message, message: "Context Room not found" });
          }
          throw error;
        }
      },
    );

    app.post(
      "/v1/context-rooms/selection-rewrite",
      {
        schema: {
          tags: ["context-rooms"],
          body: Type.Object({
            roomId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            documentName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            selectedText: Type.String({ minLength: 1, maxLength: 20_000 }),
            instruction: Type.Optional(Type.String({ maxLength: 2_000 })),
            contextBefore: Type.Optional(Type.String({ maxLength: 4_000 })),
            contextAfter: Type.Optional(Type.String({ maxLength: 4_000 })),
            blockType: Type.Optional(Type.String({ maxLength: 64 })),
            responseLanguage: Type.Optional(Type.String({ minLength: 2, maxLength: 35 })),
          }, { additionalProperties: false }),
        },
      },
      async (request, reply) => {
        if (!roomAgent) {
          return reply.code(503).send({ error: "context_room_agent_not_configured" });
        }
        const body = request.body;
        if (!body.selectedText.trim()) {
          return reply.code(400).send({ error: "context_room_selection_required" });
        }
        const invocationId = await roomAgent.dispatchDetached({
          task: "selection-rewrite",
          taskInput: {
            selectedText: body.selectedText,
            ...(body.instruction?.trim() ? { instruction: body.instruction.trim() } : {}),
            ...(body.contextBefore?.trim() ? { contextBefore: body.contextBefore } : {}),
            ...(body.contextAfter?.trim() ? { contextAfter: body.contextAfter } : {}),
            ...(body.blockType?.trim() ? { blockType: body.blockType } : {}),
            ...(body.roomId ? { roomId: body.roomId } : {}),
            ...(body.documentName ? { documentName: body.documentName } : {}),
            ...(body.responseLanguage ? { responseLanguage: body.responseLanguage } : {}),
          },
        });
        return { invocationId };
      },
    );
  };
}
