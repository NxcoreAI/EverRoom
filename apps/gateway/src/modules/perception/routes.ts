import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { PerceptionService } from "./service.js";

const NodeParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }) });
const ErrorDto = Type.Object({ error: Type.String() });

function dateOf(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_date");
  return date;
}

function settingsDto(row: ReturnType<PerceptionService["settings"]>) {
  return {
    captureEnabled: row.captureEnabled,
    captureIntervalSeconds: row.captureIntervalSeconds,
    onlineVlmEnabled: row.onlineVlmEnabled,
    configVersion: row.configVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function perceptionRoutes(service: PerceptionService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/perception/settings", { schema: { tags: ["perception"] } }, async () => settingsDto(service.settings()));

    app.patch("/v1/perception/settings", {
      schema: {
        tags: ["perception"],
        body: Type.Object({
          captureEnabled: Type.Optional(Type.Boolean()),
          captureIntervalSeconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 7_200 })),
          onlineVlmEnabled: Type.Optional(Type.Boolean()),
          configVersion: Type.Integer({ minimum: 1 }),
        }),
      },
    }, async (request, reply) => {
      try {
        return settingsDto(service.updateSettings(request.body));
      } catch (error) {
        if (error instanceof Error && ["perception_settings_conflict", "vlm_not_configured"].includes(error.message)) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    });

    app.post("/v1/perception/visual-observations", {
      schema: {
        tags: ["perception"],
        body: Type.Object({
          fileId: Type.String({ minLength: 1 }),
          kind: Type.Union([Type.Literal("screenshot"), Type.Literal("photo")]),
          capturedAt: Type.String({ format: "date-time" }),
          perceptualHash: Type.Optional(Type.String({ pattern: "^[0-9a-fA-F]{16}$" })),
          width: Type.Optional(Type.Integer({ minimum: 1 })),
          height: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
      },
    }, async (request, reply) => {
      try {
        return service.registerObservation({ ...request.body, capturedAt: new Date(request.body.capturedAt) });
      } catch (error) {
        const code = error instanceof Error ? error.message : "invalid_observation";
        return reply.code(code === "file_not_found" ? 404 : 400).send({ error: code });
      }
    });

    app.get("/v1/perception/nodes", {
      schema: {
        tags: ["perception"],
        querystring: Type.Object({
          from: Type.Optional(Type.String()),
          to: Type.Optional(Type.String()),
          kind: Type.Optional(Type.Union([
            Type.Literal("audio"), Type.Literal("screenshot"), Type.Literal("photo"),
            Type.Literal("document"), Type.Literal("file"),
          ])),
          status: Type.Optional(Type.String()),
        }),
      },
    }, async (request, reply) => {
      try {
        const from = dateOf(request.query.from);
        const to = dateOf(request.query.to);
        return { items: service.list({
          ...(from ? { from } : {}), ...(to ? { to } : {}),
          ...(request.query.kind ? { kind: request.query.kind } : {}),
          ...(request.query.status ? { status: request.query.status } : {}),
        }) };
      } catch {
        return reply.code(400).send({ error: "invalid_date" });
      }
    });

    app.get("/v1/perception/nodes/:id", {
      schema: { tags: ["perception"], params: NodeParams },
    }, async (request, reply) => {
      const detail = service.detail(request.params.id);
      return detail ?? reply.code(404).send({ error: "perception_node_not_found" });
    });

    app.post("/v1/perception/nodes/:id/retry", {
      schema: { tags: ["perception"], params: NodeParams },
    }, async (request, reply) => {
      try {
        service.retry(request.params.id);
        return reply.code(202).send({ accepted: true });
      } catch (error) {
        const code = error instanceof Error ? error.message : "retry_failed";
        return reply.code(code === "perception_node_not_found" ? 404 : 409).send({ error: code });
      }
    });

    app.delete("/v1/perception/nodes/:id", {
      schema: {
        tags: ["perception"], params: NodeParams,
        querystring: Type.Object({ deleteAssets: Type.Optional(Type.Boolean({ default: false })) }),
      },
    }, async (request, reply) => {
      try {
        return await service.delete(request.params.id, request.query.deleteAssets ?? false);
      } catch (error) {
        if (error instanceof Error && error.message === "perception_node_not_found") {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
    });
  };
}
