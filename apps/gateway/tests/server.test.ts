import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server/create-server.js";

const temporaryDirectories: string[] = [];

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-gateway-test-"));
  temporaryDirectories.push(dataDir);
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    databasePath: join(dataDir, "database", "gateway.sqlite"),
    migrationsDir: resolve("drizzle"),
    runtimeManifestPath: join(dataDir, "runtime", "gateway.json"),
    logLevel: "silent",
    authToken: "test-token-0123456789",
    agentRuntime: "fake",
    pi: null,
    asrInputDir: join(dataDir, "recordings"),
    asr: null,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("gateway server", () => {
  it("reports liveness without authentication", async () => {
    const app = await createServer(await testConfig());
    const response = await app.inject({ method: "GET", url: "/v1/health/live" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "nxcore-gateway" });
  });

  it("protects non-health routes with a bearer token", async () => {
    const config = await testConfig();
    const app = await createServer(config);

    const unauthorized = await app.inject({ method: "GET", url: "/v1/system/info" });
    const authorized = await app.inject({
      method: "GET",
      url: "/v1/system/info",
      headers: { authorization: `Bearer ${config.authToken}` },
    });
    await app.close();

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
  });

  it("serves API documentation without authentication", async () => {
    const app = await createServer(await testConfig());
    const response = await app.inject({ method: "GET", url: "/docs/json" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().openapi).toBe("3.0.3");
  });

  it("persists structured logs in the gateway data directory", async () => {
    const config = await testConfig();
    config.logLevel = "info";
    const app = await createServer(config);
    app.log.info({ testMarker: "gateway-log-test" }, "log persistence test");
    await app.close();

    const logsDirectory = join(config.dataDir, "logs");
    const logFiles = (await readdir(logsDirectory)).filter(
      (file) => /^gateway\.\d{4}-\d{2}-\d{2}\.\d+\.log$/.test(file),
    );
    expect(logFiles).toHaveLength(1);

    const entries = (await readFile(join(logsDirectory, logFiles[0]!), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const markerEntry = entries.find((entry) => entry.testMarker === "gateway-log-test");
    expect(markerEntry).toMatchObject({ msg: "log persistence test" });
    expect(markerEntry?.time).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  });
});
