import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { DocumentMcpHost } from "./mcp-host.js";

const ContextQuery = Type.Object({
  agentSessionId: Type.String({ minLength: 1, maxLength: 128 }),
  runId: Type.String({ minLength: 1, maxLength: 128 }),
  roomId: Type.String({ minLength: 1, maxLength: 128 }),
});

const SessionParams = Type.Object({
  sessionId: Type.String({ minLength: 1, maxLength: 128 }),
});

const JsonRpcMessage = Type.Object({
  jsonrpc: Type.Literal("2.0"),
}, { additionalProperties: true });

export function documentMcpRoutes(host: DocumentMcpHost): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post(
      "/v1/mcp/documents/:sessionId",
      {
        schema: {
          tags: ["documents", "mcp"],
          params: SessionParams,
          querystring: ContextQuery,
          body: JsonRpcMessage,
        },
      },
      async (request, reply) => {
        const messages = await host.exchange(request.params.sessionId, request.body, {
          agentSessionId: request.query.agentSessionId,
          runId: request.query.runId,
          roomId: request.query.roomId,
        });
        if (messages.length === 0) return reply.code(202).send();
        return reply
          .type("application/json")
          .send(messages.length === 1 ? messages[0] : messages);
      },
    );

    const methodNotAllowed = async (_request: unknown, reply: {
      code(statusCode: number): { send(payload: unknown): unknown };
    }) => reply.code(405).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });

    app.get(
      "/v1/mcp/documents/:sessionId",
      { schema: { tags: ["documents", "mcp"], params: SessionParams } },
      methodNotAllowed,
    );
    app.delete(
      "/v1/mcp/documents/:sessionId",
      { schema: { tags: ["documents", "mcp"], params: SessionParams } },
      methodNotAllowed,
    );
  };
}
