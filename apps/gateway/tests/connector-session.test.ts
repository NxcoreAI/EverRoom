import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCliConnectorSession, connectorSessionRoutes } from "../src/modules/connectors/session-routes.js";
import { createServer } from "../src/server/create-server.js";
import type { GatewayConfig } from "../src/config.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((x) => rm(x, { recursive: true, force: true }))));

describe("applyCliConnectorSession", () => {
  it("patches the config object in place so reference-holding consumers see the update", () => {
    const config = { cliConnector: { executable: "oo", baseUrl: "https://oo.example.com/", configDirectory: "/c", dataDirectory: "/d", runtimeToken: "oct-old" } } as Pick<GatewayConfig, "cliConnector">;
    const held = config.cliConnector!;
    applyCliConnectorSession(config as GatewayConfig, { baseUrl: "https://oo2.example.com/", runtimeToken: "oct-new" });
    expect(held).toBe(config.cliConnector);
    expect(held.baseUrl).toBe("https://oo2.example.com");
    expect(held.runtimeToken).toBe("oct-new");
    applyCliConnectorSession(config as GatewayConfig, null);
    expect(held.baseUrl).toBe("");
    expect(held.runtimeToken).toBeUndefined();
  });

  it("is a no-op when cliConnector is absent (unmanaged deployments)", () => {
    const config = { cliConnector: null } as Pick<GatewayConfig, "cliConnector">;
    expect(() => applyCliConnectorSession(config as GatewayConfig, { baseUrl: "https://oo.example.com" })).not.toThrow();
    expect(config.cliConnector).toBeNull();
  });
});

describe("connector session routes", () => {
  it("requires auth and applies sessions without a gateway restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "connector-session-"));
    dirs.push(dir);
    const app = await createServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      databasePath: join(dir, "gateway.sqlite"),
      migrationsDir: resolve("drizzle"),
      runtimeManifestPath: join(dir, "runtime.json"),
      logLevel: "silent",
      authToken: "test-token-0123456789",
      agentRuntime: "fake",
      pi: null,
      backgroundPi: null,
      cursorCompletionPi: null,
      litePi: null,
      mcpConfigPath: join(dir, "agent", "mcp.json"),
      webSearch: null,
    } as Parameters<typeof createServer>[0]);
    const headers = { authorization: "Bearer test-token-0123456789" };
    expect((await app.inject({ method: "PUT", url: "/v1/connector-session", payload: { baseUrl: "https://oo.example.com" } })).statusCode).toBe(401);
    const applied = await app.inject({
      method: "PUT",
      url: "/v1/connector-session",
      headers,
      payload: { baseUrl: "https://oo.example.com/", runtimeToken: "oct-test" },
    });
    expect(applied.statusCode).toBe(200);
    // 响应不回显 token（preSerialization 脱敏之外的双保险：schema 本就不含）。
    expect(applied.json()).toEqual({ configured: true, baseUrl: "https://oo.example.com" });
    const cleared = await app.inject({ method: "DELETE", url: "/v1/connector-session", headers });
    expect(cleared.json()).toEqual({ configured: false, baseUrl: "" });
    expect((await app.inject({ method: "PUT", url: "/v1/connector-session", headers, payload: { runtimeToken: "oct-x" } })).statusCode).toBe(400);
    await app.close();
  });

  it("invokes the session-changed hook (agent hot reload trigger)", async () => {
    const calls: string[] = [];
    const app = await (await import("fastify")).default({ logger: false });
    const config = { cliConnector: { executable: "oo", baseUrl: "", configDirectory: "/c", dataDirectory: "/d" } } as Pick<GatewayConfig, "cliConnector">;
    await app.register(connectorSessionRoutes({
      config: config as GatewayConfig,
      onSessionChanged: () => { calls.push("changed"); },
    }));
    await app.ready();
    await app.inject({ method: "PUT", url: "/v1/connector-session", payload: { baseUrl: "https://oo.example.com" } });
    await app.inject({ method: "DELETE", url: "/v1/connector-session" });
    expect(calls).toEqual(["changed", "changed"]);
    await app.close();
  });
});
