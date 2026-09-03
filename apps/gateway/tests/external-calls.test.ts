import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, RuntimeRun, StartRuntimeRunInput } from "@nxcore/agent-runtime";
import { externalCallRoutes } from "../src/modules/external-calls/routes.js";
import {
  ExternalCallBudgetExceededError,
  ExternalCallBudgetService,
} from "../src/modules/external-calls/service.js";
import { createOpenConnectorPiTools } from "@nxcore/connectors-module/open-connector-tools.js";
import { createWebSearchPiTools } from "../src/modules/agent/web-search-tools.js";
import { createNangoPiTools } from "@nxcore/connectors-module/nango-agent-tools.js";
import { AgentResolver } from "../src/modules/agent/resolver.js";
import { auth } from "../src/server/auth.js";

const migration = readFileSync(resolve(import.meta.dirname, "../drizzle/0030_external_call_budgets.sql"), "utf8");
const databases: Database.Database[] = [];

function harness(
  now: () => Date = () => new Date("2026-08-25T00:00:00.000Z"),
  identity: { userId?: string; workspaceId?: string } = {},
) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(migration);
  databases.push(sqlite);
  return { sqlite, service: new ExternalCallBudgetService(sqlite, now, identity) };
}

function policy(
  service: "WEB_SEARCH" | "MCP" | "CONNECTOR",
  limit: number,
  input: Partial<Parameters<ExternalCallBudgetService["upsertPolicy"]>[0]> = {},
) {
  return {
    subjectScope: "service" as const,
    subjectId: service,
    service,
    period: "UTC_DAY" as const,
    limit,
    warningThreshold: limit,
    enforcement: "BLOCK" as const,
    ...input,
  };
}

const context = (extra: { userId?: string; workspaceId?: string } = {}) => ({
  source: "test",
  runId: "run-1",
  correlationId: "correlation-1",
  ...extra,
});

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("external call budgets", () => {
  it("atomically lets only limit concurrent calls reach a provider", async () => {
    const { service } = harness();
    service.upsertPolicy(policy("WEB_SEARCH", 3, {
      subjectScope: "user",
      subjectId: "user-a",
      warningThreshold: 2,
    }));
    let providerCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const calls = Array.from({ length: 10 }, (_, index) => service.execute(
      "WEB_SEARCH",
      "web_search",
      context({ userId: "user-a" }),
      async (markDispatched) => {
        markDispatched();
        providerCalls += 1;
        await gate;
        return index;
      },
    ));

    expect(providerCalls).toBe(3);
    release();
    const results = await Promise.allSettled(calls);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(7);
    expect(service.listUsage({ subjectScope: "user", subjectId: "user-a" }).items[0])
      .toMatchObject({ reservedCalls: 0, consumedCalls: 3, atLimit: true });
  });

  it("does not block AUDIT_ONLY and consumes provider failures with stable codes", async () => {
    const { service } = harness();
    service.upsertPolicy(policy("CONNECTOR", 1, {
      enforcement: "AUDIT_ONLY",
      warningThreshold: 1,
    }));
    await service.execute("CONNECTOR", "connector_run", context(), async (mark) => { mark(); return "ok"; });
    await expect(service.execute("CONNECTOR", "connector_run", context(), async (mark) => {
      mark();
      throw new Error("CANARY_RAW_PROVIDER_BODY api_key=secret query=private");
    })).rejects.toThrow("CANARY_RAW_PROVIDER_BODY");

    expect(service.listUsage({ service: "CONNECTOR" }).items[0])
      .toMatchObject({ consumedCalls: 2, atLimit: true, enforcement: "AUDIT_ONLY" });
    const serialized = JSON.stringify(service.listAudits({ service: "CONNECTOR" }));
    expect(serialized).not.toContain("CANARY_RAW_PROVIDER_BODY");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("query=private");
    expect(service.listAudits({ service: "CONNECTOR" }).items.find((item) => item.outcome === "FAILED"))
      .toMatchObject({ outcome: "FAILED", failureCode: "PROVIDER_FAILURE", consumedCalls: 1 });
  });

  it("releases a reservation when dispatch never happened", async () => {
    const { service } = harness();
    service.upsertPolicy(policy("MCP", 1));
    await expect(service.execute("MCP", "server.tool", context(), async () => {
      throw new Error("local_preflight_failed");
    })).rejects.toThrow("local_preflight_failed");

    expect(service.listUsage({ service: "MCP" }).items[0])
      .toMatchObject({ reservedCalls: 0, consumedCalls: 0 });
    expect(service.listAudits({ service: "MCP" }).items[0])
      .toMatchObject({ outcome: "RELEASED", failureCode: "NOT_DISPATCHED", consumedCalls: 0 });
  });

  it("applies every real user, workspace, and service rule", async () => {
    const { service } = harness();
    service.upsertPolicy(policy("WEB_SEARCH", 5));
    service.upsertPolicy(policy("WEB_SEARCH", 0, {
      subjectScope: "user",
      subjectId: "user-a",
      warningThreshold: 0,
      enforcement: "AUDIT_ONLY",
    }));
    service.upsertPolicy(policy("WEB_SEARCH", 1, {
      subjectScope: "workspace",
      subjectId: "workspace-a",
    }));
    const owned = context({ userId: "user-a", workspaceId: "workspace-a" });
    await service.execute("WEB_SEARCH", "web_search", owned, async (mark) => { mark(); return "ok"; });
    await expect(service.execute("WEB_SEARCH", "web_search", owned, async (mark) => {
      mark();
      return "blocked";
    })).rejects.toBeInstanceOf(ExternalCallBudgetExceededError);

    expect(service.listUsage({ service: "WEB_SEARCH" }).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectScope: "user", consumedCalls: 1, enforcement: "AUDIT_ONLY" }),
      expect.objectContaining({ subjectScope: "workspace", consumedCalls: 1, atLimit: true }),
      expect.objectContaining({ subjectScope: "service", consumedCalls: 1 }),
    ]));
    expect(service.listAudits({ service: "WEB_SEARCH" }).items.find((item) => item.outcome === "BLOCKED"))
      .toMatchObject({ outcome: "BLOCKED", failureCode: "BUDGET_EXCEEDED" });
  });

  it("uses UTC day and month boundaries", async () => {
    let current = new Date("2026-01-31T23:59:59.000Z");
    const { service } = harness(() => current);
    service.upsertPolicy(policy("MCP", 10));
    service.upsertPolicy(policy("MCP", 10, { period: "UTC_MONTH" }));
    await service.execute("MCP", "server.tool", context(), async (mark) => { mark(); return null; });
    current = new Date("2026-02-01T00:00:00.000Z");
    await service.execute("MCP", "server.tool", context(), async (mark) => { mark(); return null; });

    const usage = service.listUsage({ service: "MCP", limit: 20 }).items;
    expect(usage.filter((item) => item.period === "UTC_DAY").map((item) => item.periodStart).sort())
      .toEqual(["2026-01-31T00:00:00.000Z", "2026-02-01T00:00:00.000Z"]);
    expect(usage.filter((item) => item.period === "UTC_MONTH").map((item) => item.periodStart).sort())
      .toEqual(["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"]);
  });

  it("queries audit ownership and pagination without serializing call payloads", async () => {
    const { service } = harness();
    for (const userId of ["user-a", "user-b", "user-a"]) {
      await service.execute("CONNECTOR", "connector_run", context({ userId }), async (mark) => {
        const canaryArgs = { query: "CANARY_QUERY", result: "CANARY_RESULT", key: "CANARY_KEY" };
        expect(canaryArgs.query).toBe("CANARY_QUERY");
        mark();
        return canaryArgs;
      });
    }
    const first = service.listAudits({ subjectScope: "user", subjectId: "user-a", limit: 1 });
    const second = service.listAudits({ subjectScope: "user", subjectId: "user-a", limit: 1, offset: 1 });
    expect(first.total).toBe(2);
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(JSON.stringify([first, second])).not.toMatch(/CANARY_(QUERY|RESULT|KEY)/);
  });

  it("protects policy and query routes with the existing bearer auth", async () => {
    const { service } = harness();
    const app = Fastify();
    await app.register(auth, { token: "0123456789abcdef" });
    await app.register(externalCallRoutes(service));
    expect((await app.inject({ method: "GET", url: "/v1/external-calls/policies" })).statusCode).toBe(401);
    const headers = { authorization: "Bearer 0123456789abcdef" };
    expect((await app.inject({
      method: "PUT",
      url: "/v1/external-calls/policies",
      headers,
      payload: policy("WEB_SEARCH", 2, { warningThreshold: 1 }),
    })).statusCode).toBe(200);
    const response = await app.inject({ method: "GET", url: "/v1/external-calls/policies?service=WEB_SEARCH", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ subjectScope: "service", service: "WEB_SEARCH" })],
    });
    await app.close();
  });

  it("meters current user and workspace policies at real Agent tool boundaries", async () => {
    const { service } = harness(undefined, { userId: "user-a", workspaceId: "workspace-a" });
    service.upsertPolicy(policy("WEB_SEARCH", 1, {
      subjectScope: "user",
      subjectId: "user-a",
    }));
    service.upsertPolicy(policy("CONNECTOR", 1, {
      subjectScope: "workspace",
      subjectId: "workspace-a",
    }));
    let webProviderCalls = 0;
    const runtime: AgentRuntime = {
      id: "web-search-test",
      getCapabilities: async () => ({ streaming: true, reasoning: false, tools: false, steering: false, resume: false }),
      start: async (input: StartRuntimeRunInput): Promise<RuntimeRun> => {
        webProviderCalls += 1;
        return {
          runId: input.runId,
          runtimeSessionRef: "web-ref",
          events: (async function* () {
            yield { type: "message.completed" as const, payload: { content: "search result" } };
          })(),
        };
      },
      resume: async () => { throw new Error("unused"); },
      sendInput: async () => undefined,
      cancel: async () => undefined,
      deleteSession: async () => undefined,
      dispose: async () => undefined,
    };
    const resolver = new AgentResolver();
    resolver.register({
      id: "web-search",
      name: "Web Search",
      description: "test",
      configDirectory: "test",
      kind: "builtin",
    }, () => runtime);
    const webTool = createWebSearchPiTools(resolver, service)[0]!;
    const input = {
      runId: "run-1", sessionId: "session-1", runtimeSessionRef: null,
      prompt: "latest", pageLabel: "test", roomId: null,
    };
    await webTool.execute(input, { query: "latest" });
    await expect(webTool.execute(input, { query: "again" })).rejects.toBeInstanceOf(ExternalCallBudgetExceededError);
    expect(webProviderCalls).toBe(1);
    expect(service.listUsage({ subjectScope: "user", subjectId: "user-a" }).items[0])
      .toMatchObject({ consumedCalls: 1, atLimit: true });

    const runner = vi.fn(async () => []);
    const connectorTool = createOpenConnectorPiTools({
      executable: "oo",
      baseUrl: "http://mock.invalid",
      runtimeToken: "mock",
      configDirectory: "mock",
      dataDirectory: "mock",
    }, runner, service)[0]!;
    await connectorTool.execute(input, { query: "list issues" });
    await expect(connectorTool.execute(input, { query: "list repos" }))
      .rejects.toBeInstanceOf(ExternalCallBudgetExceededError);
    expect(runner).toHaveBeenCalledOnce();
    expect(service.listUsage({ subjectScope: "workspace", subjectId: "workspace-a" }).items[0])
      .toMatchObject({ consumedCalls: 1, atLimit: true });
    expect(service.listAudits({ service: "CONNECTOR" }).items[0])
      .toMatchObject({ userId: "user-a", workspaceId: "workspace-a" });
    expect(service.listAudits({ subjectScope: "workspace", subjectId: "workspace-a" }).total).toBe(4);
  });

  it("meters only the Nango request that reaches the connector provider", async () => {
    const { service } = harness();
    service.upsertPolicy(policy("CONNECTOR", 1));
    const manager = {
      repository: {
        listConnections: () => [],
        listScopes: () => [],
        getConnection: () => ({
          id: "connection-1",
          status: "active",
          connectionName: "nango-1",
          service: "gmail",
        }),
        getScope: () => ({ id: "scope-1" }),
      },
      trigger: () => ({ id: "sync-1", scopeId: "scope-1", mode: "incremental", status: "queued" }),
    };
    const proxyGet = vi.fn(async () => ({ messages: [] }));
    const tools = createNangoPiTools(manager as never, { proxyGet } as never, service);
    const input = {
      runId: "run-1", sessionId: "session-1", runtimeSessionRef: null,
      prompt: "mail", pageLabel: "test", roomId: null,
    };

    await tools.find((tool) => tool.name === "nango_connections")!.execute(input, {});
    await tools.find((tool) => tool.name === "nango_sync_trigger")!.execute(input, { scopeId: "scope-1" });
    const request = tools.find((tool) => tool.name === "nango_request")!;
    await request.execute(input, {
      connectionId: "connection-1",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      query: { q: "CANARY_QUERY" },
    });
    const blocked = await request.execute(input, {
      connectionId: "connection-1",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    }).catch((error: unknown) => error);

    expect(blocked).toBeInstanceOf(ExternalCallBudgetExceededError);
    expect(request.classifyFailure?.(blocked, input, {}))
      .toMatchObject({ category: "external_call_budget_exceeded", recoverable: true });
    expect(proxyGet).toHaveBeenCalledOnce();
    expect(service.listUsage({ service: "CONNECTOR" }).items[0]).toMatchObject({ consumedCalls: 1, atLimit: true });
    const audits = service.listAudits({ service: "CONNECTOR" });
    expect(audits.items.map((item) => item.tool)).toEqual(["nango_request", "nango_request"]);
    expect(JSON.stringify(audits)).not.toContain("CANARY_QUERY");
  });

  it("hooks MCP budgets around both direct and proxy client.callTool paths", () => {
    const patch = readFileSync(resolve(import.meta.dirname, "../../../patches/pi-mcp-adapter@2.26.1.patch"), "utf8");
    expect(patch.match(/state\.callTool\(\{ server:/g)).toHaveLength(2);
    expect(patch.match(/error\.name === "ExternalCallBudgetExceededError"/g)).toHaveLength(2);
    const runtimeSource = readFileSync(resolve(import.meta.dirname, "../../../packages/agent-runtime-pi/src/index.ts"), "utf8");
    expect(runtimeSource).toContain("executeMcpCall!(input");
    const subagentSource = readFileSync(resolve(import.meta.dirname, "../src/modules/subagents/runtime-manager.ts"), "utf8");
    expect(subagentSource).toContain('this.externalCalls!.execute("MCP"');
    const serverSource = readFileSync(resolve(import.meta.dirname, "../src/server/create-server.ts"), "utf8");
    expect(serverSource).toContain("new SubagentRuntimeManager(config, subagentConfig, externalCalls)");
  });
});
