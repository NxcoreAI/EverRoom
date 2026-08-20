import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { ContextRoomService } from "./service.js";

const RoomData = Type.Object({}, { additionalProperties: true });
const RoomSnapshotItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  title: Type.String({ minLength: 1, maxLength: 120 }),
  kind: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  data: RoomData,
});

export function contextRoomRoutes(service: ContextRoomService): FastifyPluginAsyncTypebox {
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
          }, { additionalProperties: false }),
        },
      },
      async (request, reply) => {
        try {
          return await service.createRoom(request.body);
        } catch (error) {
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
  };
}
