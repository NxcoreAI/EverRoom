import { describe, expect, it } from "vitest";
import type { ConnectorActionRuntime } from "@nxcore/connectors-module/query/index.js";
import { createConnectorContextResolver } from "../src/modules/connectors/connector-context.js";

function runtime(connections: Array<{ service: string; connectionName: string; status?: string }>): ConnectorActionRuntime {
  return {
    async listConnections() {
      return connections;
    },
    async runAction() {
      return {};
    },
  };
}

describe("connector run context", () => {
  it("summarizes connected services and query capability", async () => {
    const resolve = createConnectorContextResolver(runtime([
      { service: "gmail", connectionName: "default" },
      { service: "feishu", connectionName: "default" },
    ]));
    const text = await resolve();
    expect(text).toContain("<connectors>");
    expect(text).toContain("gmail（支持模糊查询");
    expect(text).toContain("feishu（仅支持 action/链接读取");
    expect(text).toContain("coverage");
  });

  it("returns null when nothing is connected or the runtime is unavailable", async () => {
    const empty = createConnectorContextResolver(runtime([]));
    await expect(empty()).resolves.toBeNull();
    const broken = createConnectorContextResolver({
      async listConnections() { throw new Error("oo_down"); },
      async runAction() { return {}; },
    });
    await expect(broken()).resolves.toBeNull();
  });

  it("caches the summary for the TTL window", async () => {
    let calls = 0;
    const resolve = createConnectorContextResolver({
      async listConnections() { calls += 1; return [{ service: "gmail", connectionName: "default" }]; },
      async runAction() { return {}; },
    }, { ttlMs: 60_000 });
    await resolve();
    await resolve();
    expect(calls).toBe(1);
  });
});
