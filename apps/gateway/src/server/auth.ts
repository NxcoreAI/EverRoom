import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const authPlugin: FastifyPluginAsync<{ token: string }> = async (app, options) => {
  app.decorate("authToken", options.token);

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/v1/health") || request.url.startsWith("/docs")) {
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
