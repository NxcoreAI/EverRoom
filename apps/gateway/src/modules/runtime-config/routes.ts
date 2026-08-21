import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { RuntimeConfigManager } from "../../runtime-config.js";

const ConfigBody = Type.Object({}, { additionalProperties: true });
const SourceBody = Type.Object({ source: Type.Union([Type.Literal("user"), Type.Literal("saas"), Type.Literal("default")]) });

export function runtimeConfigRoutes(manager: RuntimeConfigManager): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/runtime-config", { schema: { tags: ["runtime-config"] } }, async () => manager.snapshot(true));
    app.put("/v1/runtime-config/user", { schema: { tags: ["runtime-config"], body: ConfigBody } }, async (request) => { manager.set("user", request.body); return manager.snapshot(true); });
    // Never return the decrypted SaaS payload to the renderer. The main process
    // receives the secret from SaaS, but all gateway snapshots crossing IPC are redacted.
    app.put("/v1/runtime-config/saas", { schema: { tags: ["runtime-config"], body: ConfigBody } }, async (request) => { manager.set("saas", request.body); return manager.snapshot(true); });
    app.delete("/v1/runtime-config/user", { schema: { tags: ["runtime-config"] } }, async () => { manager.clear("user"); return manager.snapshot(true); });
    app.delete("/v1/runtime-config/saas", { schema: { tags: ["runtime-config"] } }, async () => { manager.clear("saas"); return manager.snapshot(true); });
    app.put("/v1/runtime-config/source", { schema: { tags: ["runtime-config"], body: SourceBody } }, async (request) => { manager.selectSource(request.body.source); return manager.snapshot(true); });
  };
}
