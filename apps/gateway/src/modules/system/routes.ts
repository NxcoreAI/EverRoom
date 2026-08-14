import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

const GATEWAY_SERVICE_NAME = "nxcore-gateway" as const;

const HealthSchema = Type.Object({
  status: Type.Literal("ok"),
  service: Type.Literal(GATEWAY_SERVICE_NAME),
  version: Type.String(),
  pid: Type.Integer(),
  uptimeSeconds: Type.Number(),
});

const ErrorSchema = Type.Object({
  error: Type.String(),
  message: Type.String(),
  requestId: Type.String(),
});

export const systemRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/v1/health/live",
    {
      logLevel: "silent",
      schema: {
        tags: ["system"],
        response: { 200: HealthSchema },
      },
    },
    async () => ({
      status: "ok" as const,
      service: GATEWAY_SERVICE_NAME,
      version: "0.1.0",
      pid: process.pid,
      uptimeSeconds: process.uptime(),
    }),
  );

  app.get(
    "/v1/health/ready",
    {
      logLevel: "silent",
      schema: {
        tags: ["system"],
        response: { 200: HealthSchema, 503: ErrorSchema },
      },
    },
    async (_request, reply) => {
      try {
        app.db.run(sql`select 1`);
        return {
          status: "ok" as const,
          service: GATEWAY_SERVICE_NAME,
          version: "0.1.0",
          pid: process.pid,
          uptimeSeconds: process.uptime(),
        };
      } catch {
        return reply.code(503).send({
          error: "not_ready",
          message: "The gateway database is unavailable",
          requestId: _request.id,
        });
      }
    },
  );

  app.get(
    "/v1/system/info",
    {
      schema: {
        tags: ["system"],
        response: {
          200: Type.Object({
            name: Type.Literal(GATEWAY_SERVICE_NAME),
            version: Type.String(),
            node: Type.String(),
            platform: Type.String(),
          }),
        },
      },
    },
    async () => ({
      name: GATEWAY_SERVICE_NAME,
      version: "0.1.0",
      node: process.version,
      platform: process.platform,
    }),
  );
};
