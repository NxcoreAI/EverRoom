import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AgentAccessMcpHost } from "./mcp-host.js";

const JsonRpcMessage = Type.Object({
  jsonrpc: Type.Literal("2.0"),
}, { additionalProperties: true });

/**
 * 外部 Agent 访问的 MCP 端点（PRD 第 7 章）：Authorization: Bearer <连接token>
 * 自鉴权（auth 插件对 /v1/mcp/agents 豁免全局 bearer）。无效/暂停/吊销的
 * token 返回 401 + JSON-RPC -32001，与渠道 MCP 的错误形状同族。
 */
export function agentAccessMcpRoutes(host: AgentAccessMcpHost): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post(
      "/v1/mcp/agents",
      { schema: { tags: ["agent-access", "mcp"], body: JsonRpcMessage } },
      async (request, reply) => {
        try {
          const messages = await host.exchangeTrusted(request.headers.authorization, request.body);
          if (messages.length === 0) return reply.code(202).send();
          return reply
            .type("application/json")
            .send(messages.length === 1 ? messages[0] : messages);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("MCP_CONNECTION_INVALID:")) {
            return reply.code(401).send({
              jsonrpc: "2.0",
              error: { code: -32001, message: "EverRoom connection token is missing, paused or revoked" },
              id: "id" in request.body ? request.body.id ?? null : null,
            });
          }
          throw error;
        }
      },
    );

    app.get(
      "/v1/mcp/agents",
      { schema: { tags: ["agent-access", "mcp"] } },
      async (_request, reply) => reply.code(405).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      }),
    );

    app.delete(
      "/v1/mcp/agents",
      { schema: { tags: ["agent-access", "mcp"] } },
      async (request, reply) => {
        await host.closeSession(request.headers.authorization);
        return reply.code(204).send();
      },
    );
  };
}
