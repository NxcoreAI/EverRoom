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
/** 溯源二选一：主 Agent 会话（sessionId+runId）或 dispatch 子 Agent 调用（invocationId，如划词改写）。 */
const OperationContext = Type.Union([
  Type.Object({
    roomId: Type.String({ minLength: 1, maxLength: 128 }),
    documentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    sessionId: Type.String({ minLength: 1, maxLength: 128 }),
    runId: Type.String({ minLength: 1, maxLength: 128 }),
  }),
  Type.Object({
    roomId: Type.String({ minLength: 1, maxLength: 128 }),
    documentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    invocationId: Type.String({ minLength: 1, maxLength: 128 }),
  }),
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
    /** 存在时按 dispatch 子 Agent 调用校验溯源，忽略 agentSessionId/runId（值已被归一化为 invocationId）。 */
    invocationId?: string;
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
            context: OperationContext,
            input: Type.Record(Type.String(), Type.Unknown()),
          }),
        },
      },
      async (request, reply) => {
        try {
          const raw = request.body.context;
          // invocation 溯源归一化为 sessionId = runId = invocationId，operation 落库与回显保持单一形状。
          const context = "invocationId" in raw
            ? {
              roomId: raw.roomId,
              ...(raw.documentId ? { documentId: raw.documentId } : {}),
              sessionId: raw.invocationId,
              runId: raw.invocationId,
              invocationId: raw.invocationId,
            }
            : {
              roomId: raw.roomId,
              ...(raw.documentId ? { documentId: raw.documentId } : {}),
              sessionId: raw.sessionId,
              runId: raw.runId,
            };
          // 改写信任收口（方案 §3.2）：内容绑定的 invocationId 必须与溯源 invocation 一致，
          // 防止"以 A 调用授权、落地 B 调用内容"的归因错位。
          const inputInvocationId = request.body.input?.invocationId;
          if ("invocationId" in raw
            && typeof inputInvocationId === "string"
            && inputInvocationId.trim() !== raw.invocationId) {
            throw new DocumentServiceError(
              "INVALID_OPERATION_CONTEXT",
              "input.invocationId must match the invocation used for operation provenance",
              400,
            );
          }
          authorizeContext?.({
            capabilityId: request.body.capabilityId,
            agentSessionId: context.sessionId,
            runId: context.runId,
            roomId: context.roomId,
            ...("invocationId" in context ? { invocationId: context.invocationId } : {}),
          });
          return await capabilities.start({ ...request.body, context });
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
      { schema: {
        tags: ["documents", "operations"],
        params: IdParams,
        querystring: Type.Object({
          roomId: Type.String({ minLength: 1, maxLength: 128 }),
          sessionId: Type.String({ minLength: 1, maxLength: 128 }),
          runId: Type.String({ minLength: 1, maxLength: 128 }),
        }),
      } },
      async (request, reply) => {
        const operation = operations.get(request.params.id);
        if (!operation) return reply.code(404).send({ error: "operation_not_found", message: "Document operation not found" });
        if (operation.roomId !== request.query.roomId
          || operation.sessionId !== request.query.sessionId
          || operation.runId !== request.query.runId) {
          return reply.code(403).send({ error: "OPERATION_FORBIDDEN", message: "Operation belongs to another Agent run" });
        }
        return operation;
      },
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
            context: Type.Optional(Type.Object({
              roomId: Type.String({ minLength: 1, maxLength: 128 }),
              sessionId: Type.String({ minLength: 1, maxLength: 128 }),
              runId: Type.String({ minLength: 1, maxLength: 128 }),
            })),
          }),
        },
      },
      async (request, reply) => {
        try {
          const operation = operations.get(request.params.id);
          if (!operation) return reply.code(404).send({ error: "operation_not_found", message: "Document operation not found" });
          const context = request.body.context;
          if (!context
            || context.roomId !== operation.roomId
            || context.sessionId !== operation.sessionId
            || context.runId !== operation.runId) {
            return reply.code(403).send({ error: "OPERATION_FORBIDDEN", message: "Operation belongs to another Agent run" });
          }
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
