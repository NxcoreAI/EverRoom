import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ConnectorQueryService,
  QueryReadResult,
  QueryResult,
} from "@nxcore/connectors-module/query/index.js";
import { ConnectorMcpHost, isReadOnlyAction } from "../src/modules/connectors/connector-mcp-host.js";
import { ConnectorMcpServer } from "../src/modules/connectors/connector-mcp-server.js";

function queryResult(): QueryResult {
  return {
    query: "预算",
    hits: [
      {
        ref: "ref-1",
        service: "gmail",
        connection: "default",
        kind: "mail",
        title: "Q4 预算讨论",
        snippet: "预算已经确认",
        time: "2026-10-05T09:30:00.000Z",
      },
    ],
    coverage: { searched: [{ service: "gmail", connection: "default", action: "fetch_emails" }], skipped: [], failed: [], partial: false },
    truncated: false,
  };
}

function readResult(): QueryReadResult {
  return {
    ref: "ref-1",
    service: "gmail",
    connection: "default",
    kind: "mail",
    title: "Q4 预算讨论",
    markdown: "# Q4 预算讨论\n\n预算已经确认。",
    truncated: false,
    totalChars: 20,
  };
}

function fakeQuery(): ConnectorQueryService {
  return {
    query: vi.fn(async () => queryResult()),
    read: vi.fn(async () => readResult()),
  } as unknown as ConnectorQueryService;
}

function hostWith(overrides: Partial<ConstructorParameters<typeof ConnectorMcpHost>[0]> = {}) {
  const query = overrides.query ?? fakeQuery();
  const host = new ConnectorMcpHost({
    query,
    session: overrides.session ?? (() => ({ baseUrl: "https://oo.example", runtimeToken: "oct_test" })),
    ...overrides,
  });
  return { host, query };
}

async function callTool(host: ConnectorMcpHost, name: string, args: Record<string, unknown>) {
  const reply = await host.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (!reply || !("result" in reply)) throw new Error("expected result");
  return reply.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConnectorMcpHost", () => {
  it("lists oo tools plus the local query/read tools", async () => {
    const { host } = hostWith();
    const reply = await host.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(reply).not.toBeNull();
    if (!reply || !("result" in reply)) return;
    const tools = (reply.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(tools).toEqual([
      "list_apps",
      "list_connections",
      "search_actions",
      "get_action_guide",
      "execute_action",
      "connector_query",
      "connector_read",
    ]);
  });

  it("returns initialize capabilities for the MCP handshake", async () => {
    const { host } = hostWith();
    const reply = await host.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(reply).toMatchObject({
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "everroom-connectors" },
      },
    });
  });

  it("runs connector_query and returns hits plus coverage as JSON text", async () => {
    const { host, query } = hostWith();
    const result = await callTool(host, "connector_query", { concept: "预算", terms: ["budget"] });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]!.text) as { hits: unknown[]; coverage: unknown };
    expect(payload.hits).toHaveLength(1);
    expect(payload.coverage).toBeDefined();
    expect(query.query).toHaveBeenCalledWith(expect.objectContaining({ concept: "预算", terms: ["budget"] }));
  });

  it("runs connector_read and prefixes source metadata", async () => {
    const { host } = hostWith();
    const result = await callTool(host, "connector_read", { ref: "ref-1" });
    expect(result.content[0]!.text).toContain("source: gmail / default");
    expect(result.content[0]!.text).toContain("# Q4 预算讨论");
  });

  it("rejects write actions in execute_action", async () => {
    const { host } = hostWith();
    const result = await callTool(host, "execute_action", {
      actionId: "gmail.send_message",
      input: { to: "a@example.com" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("mutation_not_allowed");
  });

  it("forwards read-only actions to oo /mcp with the runtime token", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ result: { content: [{ type: "text", text: "message-body" }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const { host } = hostWith({ fetchImpl });
    const result = await callTool(host, "get_action_guide", { actionId: "gmail.get_message" });
    expect(result.content[0]!.text).toBe("message-body");
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe("https://oo.example/mcp");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer oct_test");
    expect(JSON.parse(String(init.body))).toMatchObject({
      method: "tools/call",
      params: { name: "get_action_guide", arguments: { actionId: "gmail.get_message" } },
    });
  });

  it("returns a recoverable error when the connector layer is not configured", async () => {
    const { host } = hostWith({ session: () => null });
    const result = await callTool(host, "list_apps", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("connector_not_connected");
  });

  it("classifies read actions conservatively", () => {
    expect(isReadOnlyAction("gmail.get_message")).toBe(true);
    expect(isReadOnlyAction("notion.search")).toBe(true);
    expect(isReadOnlyAction("googledrive.files.list")).toBe(true);
    expect(isReadOnlyAction("gmail.send_message")).toBe(false);
    expect(isReadOnlyAction("notion.update_page_markdown")).toBe(false);
    expect(isReadOnlyAction("googledrive.files.create")).toBe(false);
  });
});

describe("ConnectorMcpServer", () => {
  it("is compatible with the official MCP client", async () => {
    const { host } = hostWith();
    const server = new ConnectorMcpServer(host);
    const { url } = await server.start();
    const client = new Client({ name: "connector-test", version: "0.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url)) as unknown as Transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("connector_query");
      const result = await client.callTool({ name: "connector_query", arguments: { concept: "预算" } });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.type).toBe("text");
      expect(content[0]?.text).toContain("Q4 预算讨论");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serves the MCP endpoint over loopback with token-in-path", async () => {
    const { host } = hostWith();
    const server = new ConnectorMcpServer(host);
    const { url } = await server.start();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { result: { tools: Array<{ name: string }> } };
      expect(payload.result.tools.map((tool) => tool.name)).toContain("connector_query");

      const unauthorized = await fetch(url.replace(/[^/]+$/, "wrong-token"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(unauthorized.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
