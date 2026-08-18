import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { DocumentMcpHost } from "./mcp-host.js";

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
          body: JsonRpcMessage,
        },
      },
      async (request, reply) => {
        try {
          const messages = await host.exchangeTrusted(request.params.sessionId, request.body);
          if (messages.length === 0) return reply.code(202).send();
          return reply
            .type("application/json")
            .send(messages.length === 1 ? messages[0] : messages);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("MCP_SESSION_INVALID:")) {
            return reply.code(404).send({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Trusted MCP session is missing or expired" },
              id: "id" in request.body ? request.body.id ?? null : null,
            });
          }
          throw error;
        }
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
      async (request, reply) => {
        await host.closeTrustedSession(request.params.sessionId);
        return reply.code(204).send();
      },
    );
  };
}
