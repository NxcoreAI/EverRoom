import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { ContextRoomService } from "./service.js";
import { DuplicateReviewRequiredError, type RoomDuplicateService } from "./duplicate-service.js";

const RoomData = Type.Object({}, { additionalProperties: true });
const RoomSnapshotItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  title: Type.String({ minLength: 1, maxLength: 120 }),
  kind: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  data: RoomData,
});

export function contextRoomRoutes(service: ContextRoomService, duplicates?: RoomDuplicateService): FastifyPluginAsyncTypebox {
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
  };
}
