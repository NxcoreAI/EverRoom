import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type GatewayConfig } from "../src/config.js";
import { invokeRuntime } from "../src/modules/agent/invoke.js";
import { createAgentResolver } from "../src/modules/agent/runtime-factory.js";
import { createWebSearchPiTools } from "../src/modules/agent/web-search-tools.js";
import { createServer } from "../src/server/create-server.js";
import gatewayPackage from "../package.json" with { type: "json" };

const parallelUrl = "https://mcp.parallel.ai/mcp";
const publicQuery = "When did Apollo 11 land on the Moon?";
const sourceUrl = "https://www.nasa.gov/mission/apollo-11/?ref=a%2Fb";
const testDisposables: Array<() => Promise<void>> = [];
const primaryEnv = {
  NXCORE_AGENT_RUNTIME: "pi",
  NXCORE_AI_PROVIDER: "web-search-test",
  NXCORE_AI_MODEL: "fixture",
  NXCORE_AI_API: "openai-completions",
  NXCORE_AI_API_KEY: "local-test-key",
  NXCORE_AI_REASONING: "off",
  NXCORE_GATEWAY_LOG_LEVEL: "silent",
  NXCORE_SUBAGENTS_ENABLED: "false",
};

beforeEach(() => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dispose of testDisposables.splice(0).reverse()) await dispose();
});

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function listen(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>): Promise<string> {
  const server = createHttpServer((request, response) => {
    void handle(request, response).catch(() => response.writeHead(500).end());
  });
  return bind(server);
}

async function bind(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  testDisposables.push(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  return `http://127.0.0.1:${address.port}`;
}

type SearchReply = (response: ServerResponse, id: unknown, call: number) => void;

async function captureParallel(reply: SearchReply) {
  const calls: Array<{
    method: string;
    userAgent: string | undefined;
    authorized: boolean;
    session: string | undefined;
    params: unknown;
  }> = [];
  let connection = 0;
  let toolCalls = 0;
  const url = await listen(async (request, response) => {
    const message = request.method === "POST" ? await readJson(request) : {};
    const method = String(message.method ?? request.method);
    calls.push({
      method,
      userAgent: request.headers["user-agent"],
      authorized: Boolean(request.headers.authorization || request.headers["x-api-key"] || request.headers.cookie),
      session: String(request.headers["mcp-session-id"] ?? "") || undefined,
      params: method === "tools/call" ? message.params : undefined,
    });
    if (method === "initialize") {
      response.setHeader("mcp-session-id", `test-session-${++connection}`);
      sendRpc(response, message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
    } else if (method === "tools/list") {
      sendRpc(response, message.id, { tools: [{ name: "web_search", inputSchema: { type: "object" } }] });
    } else if (method === "tools/call") {
      reply(response, message.id, ++toolCalls);
    } else {
      response.writeHead(method === "GET" ? 405 : 202).end();
    }
  });
  // Change the destination only. The SDK sends the real request to the fixture.
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    realFetch(String(input) === parallelUrl ? `${url}/mcp` : input, init));
  return calls;
}

function sendRpc(response: ServerResponse, id: unknown, result: unknown): void {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

async function loadTestConfig(modelUrl: string, env: NodeJS.ProcessEnv): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "everroom-web-search-"));
  testDisposables.push(() => rm(dataDir, { recursive: true, force: true }));
  return loadConfig(["--data-dir", dataDir], { ...primaryEnv, NXCORE_AI_BASE_URL: `${modelUrl}/v1`, ...env });
}

async function gatewayChat(env: NodeJS.ProcessEnv) {
  const modelUrl = await listen(async (request, response) => {
    const body = await readJson(request) as {
      tools?: Array<{ function: { name: string } }>;
      messages: Array<{ role: string; content: string }>;
    };
    const tools = body.tools?.map(({ function: tool }) => tool.name) ?? [];
    const result = body.messages.findLast(({ role }) => role === "tool")?.content;
    const wantsSearch = tools.includes("web_search") && result === undefined;
    const delta = wantsSearch ? {
      tool_calls: [{ index: 0, id: "call-search", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: publicQuery }) } }],
    } : { content: result ?? "Search unavailable" };
    const chunk = { id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: wantsSearch ? "tool_calls" : "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const config = await loadTestConfig(modelUrl, env);
  const app = await createServer(config);
  testDisposables.push(() => app.close());
  const headers = { authorization: `Bearer ${config.authToken}` };

  async function run(toolsEnabled = true): Promise<string> {
    const session = await app.inject({ method: "POST", url: "/v1/agent/sessions", headers, payload: { pageLabel: "Web search" } });
    expect(session.statusCode).toBe(201);
    const path = `/v1/agent/sessions/${session.json().id}`;
    const run = await app.inject({
      method: "POST", url: `${path}/runs`, headers,
      payload: { prompt: publicQuery, idempotencyKey: "search-fixture", toolsEnabled, captureMemory: false, recallMemory: false },
    });
    expect(run.statusCode).toBe(202);
    return vi.waitFor(async () => {
      const events = await app.inject({ method: "GET", url: `${path}/events?runId=${run.json().id}`, headers });
      expect(events.statusCode).toBe(200);
      const entries = events.json<Array<{ type: string; payload: { content?: string } }>>();
      expect(entries.at(-1)?.type).toBe("run.completed");
      return entries.findLast(({ type }) => type === "message.completed")?.payload.content ?? "";
    }, { timeout: 12_000 });
  }

  return { app, headers, run };
}

describe("Parallel web search", () => {
  it("returns cited evidence through Gateway chat and identifies each new MCP session on the wire", async () => {
    const calls = await captureParallel((response, id, call) => {
      const data = { results: [{ url: sourceUrl, title: "NASA", excerpts: ["Apollo 11 landed on July 20, 1969."] }] };
      if (call === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "duplicate evidence" }], structuredContent: data },
        })}\n\n`);
      } else {
        sendRpc(response, id, { content: [{ type: "text", text: JSON.stringify(data) }] });
      }
    });
    const chat = await gatewayChat({
      NXCORE_WEB_SEARCH_PROVIDER: "parallel",
      NXCORE_WEB_SEARCH_BASE_URL: "http://127.0.0.1:1/v1",
      NXCORE_WEB_SEARCH_API_KEY: "unused-incumbent-test-key",
    });
    for (let call = 0; call < 2; call += 1) {
      const answer = await chat.run();
      expect(answer).toContain(sourceUrl);
      expect(answer).toContain("July 20, 1969");
      expect(answer).not.toContain("duplicate evidence");
    }
    expect(calls.filter(({ method }) => method === "initialize" || method === "tools/list" || method === "tools/call" || method === "DELETE").map(({ method }) => method))
      .toEqual(["initialize", "tools/list", "tools/call", "DELETE", "initialize", "tools/list", "tools/call", "DELETE"]);
    expect(new Set(calls.map(({ userAgent }) => userAgent))).toEqual(new Set([`NxCore-CE/${gatewayPackage.version}`]));
    expect(calls.some(({ authorized }) => authorized)).toBe(false);
    expect(calls.filter(({ method }) => method === "tools/call")).toMatchObject([1, 2].map((session) => ({
      session: `test-session-${session}`,
      params: { name: "web_search", arguments: { objective: publicQuery, search_queries: [publicQuery] } },
    })));

    expect(await chat.run(false)).toBe("Search unavailable");
    const policy = await chat.app.inject({
      method: "PUT", url: "/v1/external-calls/policies", headers: chat.headers,
      payload: { subjectScope: "user", subjectId: "local-user", service: "WEB_SEARCH", period: "UTC_DAY", limit: 0, warningThreshold: 0, enforcement: "BLOCK" },
    });
    expect(policy.statusCode).toBe(200);
    expect(await chat.run()).toContain("external_call_budget_exceeded");
    expect(calls.filter(({ method }) => method === "tools/call")).toHaveLength(2);
    const audit = await chat.app.inject({
      method: "GET", url: "/v1/external-calls/audits?service=WEB_SEARCH", headers: chat.headers,
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items).toMatchObject([
      { tool: "web_search", outcome: "BLOCKED", consumedCalls: 0 },
      { tool: "web_search", outcome: "SUCCEEDED", consumedCalls: 1 },
      { tool: "web_search", outcome: "SUCCEEDED", consumedCalls: 1 },
    ]);
  }, 30_000);

  it("keeps the existing default request and honors the Parallel disable switch", async () => {
    const calls = await captureParallel((response) => response.writeHead(500).end());
    const legacyRequests: unknown[] = [];
    const incumbent = await listen(async (request, response) => {
      legacyRequests.push(await readJson(request));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        choices: [{ message: { content: `Incumbent search result: ${sourceUrl}` } }],
      }));
    });
    const defaults = await gatewayChat({ NXCORE_WEB_SEARCH_BASE_URL: `${incumbent}/v1`, NXCORE_WEB_SEARCH_API_KEY: "local-test-key" });
    expect(await defaults.run()).toContain(`Incumbent search result: ${sourceUrl}`);
    expect(legacyRequests).toMatchObject([{ enable_search: true }]);
    const disabled = await gatewayChat({ NXCORE_WEB_SEARCH_PROVIDER: "parallel", NXCORE_WEB_SEARCH: "false" });
    expect(await disabled.run()).toBe("Search unavailable");
    expect(calls).toEqual([]);
  }, 30_000);

  it.each<[string, SearchReply, string]>([
    ["HTTP failure", (response) => response.writeHead(429).end("upstream detail"), "HTTP failure (429)"],
    ["RPC error", (response, id) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      jsonrpc: "2.0", id, error: { code: -32000, message: "upstream detail" },
    })), "MCP failure (-32000)"],
    ["tool error", (response, id) => sendRpc(response, id, { isError: true, content: [{ type: "text", text: "upstream detail" }] }), "returned a tool error"],
    ["invalid evidence", (response, id) => sendRpc(response, id, { content: [{ type: "text", text: "upstream detail" }] }), "returned invalid data"],
    ["oversized evidence", (response, id) => sendRpc(response, id, { content: [{ type: "text", text: "x".repeat(1_050_000) }] }), "exceeded its size limit"],
  ])("reports %s through the host tool", async (_name, reply, message) => {
    await captureParallel(reply);
    await expect(executeTool()).rejects.toThrow(message);
  });

  it("rejects redirects before sending the query to another host", async () => {
    const redirectTarget = vi.fn();
    const url = await listen(async (_request, response) => {
      redirectTarget();
      response.writeHead(200).end();
    });
    await captureParallel((response) => response.writeHead(307, { location: url }).end());
    await expect(executeTool()).rejects.toThrow("Parallel web search request failed");
    expect(redirectTarget).not.toHaveBeenCalled();
  });

  it("cancels an in-flight call and closes the MCP session", async () => {
    const controller = new AbortController();
    const calls = await captureParallel((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      controller.abort();
    });
    await expect(executeTool(controller.signal)).rejects.toThrow("Agent invocation cancelled");
    expect(calls.findLast(({ method }) => method === "DELETE")?.session).toBe("test-session-1");
  });

  it("returns a readable empty result when the service found nothing", async () => {
    await captureParallel((response, id) => sendRpc(response, id, { content: [], structuredContent: { results: [] } }));
    await expect(executeTool()).resolves.toMatchObject({
      content: "Parallel 联网搜索未返回任何结果。",
      details: { query: publicQuery, agentId: "web-search" },
    });
  });

  it("keeps usable sources within the result limit even after skipped entries", async () => {
    const results = [
      { url: `https://example.org/${"a".repeat(9_900)}`, excerpts: [] },
      ...Array.from({ length: 4 }, () => ({ url: "about:blank", excerpts: [] })),
      { url: sourceUrl, title: "NASA", excerpts: ["Apollo 11 landed on July 20, 1969."] },
    ];
    await captureParallel((response, id) => sendRpc(response, id, {
      content: [], structuredContent: { results, warnings: ["fixture warning"] },
    }));
    const { content } = await executeTool();
    expect(content.length).toBeLessThanOrEqual(10_000);
    expect(content).toContain(sourceUrl);
    expect(content).toContain("July 20, 1969");
    expect(content).not.toContain("about:blank");
  });

  it("uses the Gateway HTTPS proxy for the Parallel connection", async () => {
    const connect = vi.fn();
    const proxy = createHttpServer();
    proxy.on("connect", (request, socket) => {
      connect(request.url);
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    vi.stubEnv("https_proxy", await bind(proxy));
    vi.stubEnv("no_proxy", "localhost,127.0.0.1,::1");
    const directFetch = vi.fn(async () => { throw new Error("Direct fetch is unavailable"); });
    vi.stubGlobal("fetch", directFetch);
    // Load a fresh transport module so it reads this test's proxy environment.
    vi.resetModules();
    const { ParallelWebSearchAgentRuntime } = await import("../src/modules/agent/parallel-web-search-runtime.js");
    const runtime = new ParallelWebSearchAgentRuntime("web-search");
    await expect(invokeRuntime(runtime, publicQuery, { sessionId: "search", pageLabel: "Search" }))
      .rejects.toThrow("Parallel web search request failed");
    expect(connect).toHaveBeenCalledExactlyOnceWith("mcp.parallel.ai:443");
    expect(directFetch).not.toHaveBeenCalled();
  });

  async function executeTool(signal?: AbortSignal) {
    const config = await loadTestConfig("http://127.0.0.1:1", { NXCORE_WEB_SEARCH_PROVIDER: "parallel" });
    const resolver = createAgentResolver(config);
    testDisposables.push(() => resolver.dispose());
    const [tool] = createWebSearchPiTools(resolver, undefined, true);
    return tool!.execute({ runId: "run", sessionId: "session", runtimeSessionRef: null, prompt: "", pageLabel: "Search", roomId: null }, { query: publicQuery }, signal);
  }
});
