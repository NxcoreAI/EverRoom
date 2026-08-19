import type { DocumentOperationStatus } from "@nxcore/agent-contract";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { DocumentCapabilityRegistry } from "../capabilities/registry.js";
import { DocumentServiceError } from "../errors.js";
import type { DocumentOperationService } from "./service.js";

const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) });
const OperationStatus = Type.Union([
  Type.Literal("created"), Type.Literal("running"), Type.Literal("awaiting_input"),
  Type.Literal("awaiting_review"), Type.Literal("applying"), Type.Literal("completed"),
  Type.Literal("rejected"), Type.Literal("conflicted"), Type.Literal("failed"),
  Type.Literal("cancelled"), Type.Literal("expired"),
]);

function errorPayload(error: DocumentServiceError) {
  return { error: error.code, message: error.message, ...error.details };
}

export function documentOperationRoutes(
  operations: DocumentOperationService,
  capabilities: DocumentCapabilityRegistry,
  authorizeContext?: (context: {
    capabilityId: string;
    agentSessionId: string;
    runId: string;
    roomId: string;
  }) => void,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post(
      "/v1/document-operations",
      {
        schema: {
          tags: ["documents", "operations"],
          body: Type.Object({
            capabilityId: Type.String({ minLength: 1, maxLength: 128 }),
            context: Type.Object({
              roomId: Type.String({ minLength: 1, maxLength: 128 }),
              documentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
              sessionId: Type.String({ minLength: 1, maxLength: 128 }),
              runId: Type.String({ minLength: 1, maxLength: 128 }),
            }),
            input: Type.Record(Type.String(), Type.Unknown()),
          }),
        },
      },
      async (request, reply) => {
        try {
          authorizeContext?.({
            capabilityId: request.body.capabilityId,
            agentSessionId: request.body.context.sessionId,
            runId: request.body.context.runId,
            roomId: request.body.context.roomId,
          });
          return await capabilities.start(request.body);
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send(errorPayload(error));
          }
          throw error;
        }
      },
    );

    app.get(
      "/v1/document-operations",
      {
        schema: {
          tags: ["documents", "operations"],
          querystring: Type.Object({
            roomId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            documentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            status: Type.Optional(OperationStatus),
            active: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
          }),
        },
      },
      async (request) => ({
        operations: operations.list({
          ...(request.query.roomId ? { roomId: request.query.roomId } : {}),
          ...(request.query.documentId ? { documentId: request.query.documentId } : {}),
          ...(request.query.sessionId ? { sessionId: request.query.sessionId } : {}),
          ...(request.query.status
            ? { statuses: [request.query.status as DocumentOperationStatus] }
            : {}),
          active: request.query.active === "true",
        }),
      }),
    );

    app.get(
      "/v1/document-operations/:id",
      { schema: { tags: ["documents", "operations"], params: IdParams } },
      async (request, reply) => operations.get(request.params.id)
        ?? reply.code(404).send({ error: "operation_not_found", message: "Document operation not found" }),
    );

    app.post(
      "/v1/document-operations/:id/commands",
      {
        schema: {
          tags: ["documents", "operations"],
          params: IdParams,
          body: Type.Object({
            commandId: Type.String({ minLength: 1, maxLength: 128 }),
            expectedRevision: Type.Integer({ minimum: 1 }),
            type: Type.String({ minLength: 1, maxLength: 128 }),
            payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          }),
        },
      },
      async (request, reply) => {
        try {
          return await operations.execute(
            request.params.id,
            request.body,
            (operation, command) => capabilities.command(operation, command),
          );
        } catch (error) {
          if (error instanceof DocumentServiceError) {
            return reply.code(error.statusCode).send(errorPayload(error));
          }
          throw error;
        }
      },
    );
  };
}
