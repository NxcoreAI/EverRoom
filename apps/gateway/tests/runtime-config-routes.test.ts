import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { RuntimeConfigManager } from "../src/runtime-config.js";
import { runtimeConfigRoutes } from "../src/modules/runtime-config/routes.js";

/**
 * 路由接线单测（不建库）：固化「/secrets 是唯一返回未脱敏 snapshot 的读端点」。
 * 真实的 redact/落库语义由 server.test.ts / runtime-config-validate.test.ts 覆盖；
 * 本文件用 stub manager 记录每次 snapshot(redacted) 调用，防止标志位被翻转回归。
 */
function stubManager() {
  const calls: boolean[] = [];
  const snapshot = (redacted = false) => {
    calls.push(redacted);
    return {
      config: redacted
        ? { primary: { model: "m", apiKey: "********" } }
        : { primary: { model: "m", apiKey: "real-key" } },
      source: "user" as const,
      selectedSource: "user" as const,
      availableSources: ["user" as const],
      configVersion: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  };
  return { manager: { snapshot } as unknown as RuntimeConfigManager, calls };
}

describe("runtime-config routes", () => {
  it("serves the unredacted snapshot on /secrets for main-process child env derivation", async () => {
    const { manager, calls } = stubManager();
    const app = Fastify();
    await app.register(runtimeConfigRoutes(manager));

    const secrets = await app.inject({ method: "GET", url: "/v1/runtime-config/secrets" });
    expect(secrets.statusCode).toBe(200);
    expect(secrets.json()).toMatchObject({ config: { primary: { apiKey: "real-key" } } });

    const snapshot = await app.inject({ method: "GET", url: "/v1/runtime-config" });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({ config: { primary: { apiKey: "********" } } });

    expect(calls).toEqual([false, true]);
    await app.close();
  });
});
