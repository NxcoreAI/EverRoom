import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { ChannelMcpHost } from "./channel-mcp-host.js";

const TokenParams = Type.Object({
  token: Type.String({ minLength: 16, maxLength: 64 }),
});

const JsonRpcMessage = Type.Object({
  jsonrpc: Type.Literal("2.0"),
}, { additionalProperties: true });

/**
 * 渠道会话的 EverRoom 工具 MCP 端点。token 本身即凭证
 * （channel-mcp-host 签发、auth 插件对 /v1/mcp/everroom/ 免全局 bearer）。
 */
export function channelMcpRoutes(host: ChannelMcpHost): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post(
      "/v1/mcp/everroom/:token",
      {
        schema: {
          tags: ["agent", "mcp"],
          params: TokenParams,
          body: JsonRpcMessage,
        },
      },
      async (request, reply) => {
        try {
          const messages = await host.exchangeTrusted(request.params.token, request.body);
          if (messages.length === 0) return reply.code(202).send();
          return reply
            .type("application/json")
            .send(messages.length === 1 ? messages[0] : messages);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("MCP_SESSION_INVALID:")) {
            return reply.code(404).send({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Channel MCP token is missing or expired" },
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
      "/v1/mcp/everroom/:token",
      { schema: { tags: ["agent", "mcp"], params: TokenParams } },
      methodNotAllowed,
    );
    app.delete(
      "/v1/mcp/everroom/:token",
      { schema: { tags: ["agent", "mcp"], params: TokenParams } },
      async (request, reply) => {
        await host.closeTrustedSession(request.params.token);
        return reply.code(204).send();
      },
    );
  };
}
