import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectorActionRuntime } from "@nxcore/connectors-module/query/index.js";
import { ConnectorConnectionCatalog, connectorRoutes } from "@nxcore/connectors-module/index.js";
import type { ConnectorTombstoneStore } from "../src/modules/connectors/tombstone-store.js";

class FakeRuntime implements ConnectorActionRuntime {
  connections = [
    { service: "gmail", connectionName: "default", status: "active" },
    { service: "notion", connectionName: "work", status: "active" },
  ];
  async listConnections() {
    return this.connections;
  }
  async runAction(): Promise<unknown> {
    return {};
  }
}

function memoryTombstones(): ConnectorTombstoneStore {
  const rows = new Set<string>();
  const key = (service: string, connectionName: string) => `${service}:${connectionName}`;
  return {
    has: (service, connectionName) => rows.has(key(service, connectionName)),
    add: (service, connectionName) => { rows.add(key(service, connectionName)); },
    remove: (service, connectionName) => { rows.delete(key(service, connectionName)); },
    list: () => [...rows].map((value) => {
      const [service = "", connectionName = ""] = value.split(":");
      return { service, connectionName };
    }),
  };
}

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function harness() {
  const runtime = new FakeRuntime();
  const tombstones = memoryTombstones();
  const catalog = new ConnectorConnectionCatalog(runtime, tombstones);
  const app = Fastify({ logger: false });
  apps.push(app);
  const authorization = {
    async start(provider: string) {
      return {
        id: "attempt-1",
        provider,
        status: "pending" as const,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        connection: null,
        error: null,
        authorizationUrl: "https://example.com/oauth",
      };
    },
    async status() {
      return null;
    },
  };
  await app.register(connectorRoutes(catalog, authorization));
  return { app, tombstones, catalog };
}

describe("connector routes (JIT retrieval)", () => {
  it("lists connections live from oo with stable ids", async () => {
    const { app } = await harness();
    const response = await app.inject({ method: "GET", url: "/v1/nango-connectors/connections" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ id: "gmail:default", provider: "gmail", service: "gmail", connectionName: "default" }),
      expect.objectContaining({ id: "notion:work", provider: "notion", service: "notion", connectionName: "work" }),
    ]);
  });

  it("hides disconnected connections after a tombstone is written", async () => {
    const { app } = await harness();
    const removed = await app.inject({ method: "DELETE", url: "/v1/nango-connectors/connections/gmail:default" });
    expect(removed.statusCode).toBe(200);
    const status = await app.inject({ method: "GET", url: "/v1/nango-connectors/status" });
    expect(status.json().connections.map((connection: { id: string }) => connection.id)).toEqual(["notion:work"]);
  });

  it("exposes tombstoned connections in status.disconnected (token kept, just off)", async () => {
    const { app } = await harness();
    await app.inject({ method: "DELETE", url: "/v1/nango-connectors/connections/gmail:default" });
    const status = await app.inject({ method: "GET", url: "/v1/nango-connectors/status" });
    expect(status.json().disconnected).toEqual([{ service: "gmail", connectionName: "default" }]);
  });

  it("reconnects by removing the tombstone without touching oo credentials", async () => {
    const { app, tombstones } = await harness();
    await app.inject({ method: "DELETE", url: "/v1/nango-connectors/connections/gmail:default" });
    expect(tombstones.has("gmail", "default")).toBe(true);

    const response = await app.inject({ method: "POST", url: "/v1/nango-connectors/connections/gmail:default/reconnect" });
    expect(response.statusCode).toBe(200);
    expect(tombstones.has("gmail", "default")).toBe(false);

    const status = await app.inject({ method: "GET", url: "/v1/nango-connectors/status" });
    const body = status.json();
    expect(body.connections.map((connection: { id: string }) => connection.id)).toContain("gmail:default");
    expect(body.disconnected).toEqual([]);
  });

  it("rejects reconnect for a malformed connection id", async () => {
    const { app } = await harness();
    const response = await app.inject({ method: "POST", url: "/v1/nango-connectors/connections/no-separator/reconnect" });
    expect(response.statusCode).toBe(400);
  });

  it("keeps the legacy status shape with empty scopes/runs", async () => {
    const { app } = await harness();
    const status = await app.inject({ method: "GET", url: "/v1/nango-connectors/status" });
    expect(status.json()).toMatchObject({ enabled: true, scopes: [], runs: [] });
  });

  it("exposes provider metadata for queryable services", async () => {
    const { app } = await harness();
    const providers = await app.inject({ method: "GET", url: "/v1/nango-connectors/providers" });
    const names = providers.json().providers.map((provider: { provider: string }) => provider.provider);
    expect(names).toEqual(expect.arrayContaining(["gmail", "notion"]));
  });

  it("returns 410 for sync-era endpoints", async () => {
    const { app } = await harness();
    for (const url of [
      "/v1/nango-connectors/scopes",
      "/v1/nango-connectors/runs",
      "/v1/nango-connectors/failures",
      "/v1/nango-connectors/connections/gmail:default/messages",
      "/v1/nango-connectors/connections/gmail:default/records",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({ error: "sync_removed" });
    }
  });

  it("starts local-mode authorization", async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: "POST",
      url: "/v1/nango-connectors/authorizations",
      payload: { provider: "gmail" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: "attempt-1", authorizationUrl: "https://example.com/oauth" });
  });
});
