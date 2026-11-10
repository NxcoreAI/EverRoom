import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const authPlugin: FastifyPluginAsync<{ token: string }> = async (app, options) => {
  app.decorate("authToken", options.token);

  app.addHook("onRequest", async (request, reply) => {
    // 渠道 MCP（/v1/mcp/everroom/:token）以 token-in-path 为凭证：
    // 不把网关全局 token 种进 CLI 子进程环境。
    // 外部 Agent 访问（/v1/mcp/agents）以持久连接 token（Bearer）自鉴权：
    // 凭证与范围在 agent_connections 表，由 agent-access 模块校验。
    if (request.url.startsWith("/v1/health")
      || request.url.startsWith("/docs")
      || request.url.startsWith("/v1/mcp/everroom/")
      || request.url.startsWith("/v1/mcp/agents")) {
      return;
    }

    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${options.token}`) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "A valid gateway bearer token is required",
        requestId: request.id,
      });
    }
  });
};

export const auth = fp(authPlugin, { name: "gateway-auth" });
