import { describe, expect, it } from "vitest";
import type { DocumentExecutionContext } from "../src/modules/documents/capabilities/types.js";
import type { DocumentCapabilityRegistry } from "../src/modules/documents/capabilities/registry.js";
import { ChannelMcpHost } from "../src/modules/agent/channel-mcp-host.js";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { McpServer } from "@zed-industries/agent-client-protocol";

function fakeRegistry(): DocumentCapabilityRegistry {
  return {
    listTools: () => [{
      name: "document_read",
      title: "读取文档",
      description: "读取文档",
      inputSchema: { type: "object", properties: { ref: { type: "string" } } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }],
    promptGuidelines: () => ["文档工具使用守则"],
    execute: async (name: string, args: Record<string, unknown>, _context: DocumentExecutionContext) => {
      if (name === "document_read") {
        return { content: [{ type: "text", text: `doc:${String(args.ref)}` }] };
      }
      throw new Error(`METHOD_NOT_FOUND: Unknown tool ${name}`);
    },
  } as unknown as DocumentCapabilityRegistry;
}

function runInput(sessionId: string, roomId: string | null): StartRuntimeRunInput {
  return {
    runId: `run-${sessionId}`,
    sessionId,
    runtimeSessionRef: null,
    prompt: "hi",
    pageLabel: "Agent",
  };
}

function tokenFrom(url: string): string {
  return url.split("/").pop() ?? "";
}

function issuedUrl(host: ChannelMcpHost, input: StartRuntimeRunInput): string {
  const [entry]: McpServer[] = host.mcpServersForRun(input);
  // Stdio 变体没有 url 字段（也无 type 判别），用 in 收窄到 http/sse。
  if (!entry || !("url" in entry)) throw new Error("expected http mcp server entry");
  return entry.url;
}

let nextId = 0;

async function rpc(host: ChannelMcpHost, token: string, method: string, params: Record<string, unknown> = {}) {
  const id = ++nextId;
  return await host.exchangeTrusted(token, { jsonrpc: "2.0", id, method, params });
}

describe("ChannelMcpHost", () => {
  it("resolves a lazy baseUrl at issue time so a --port 0 gateway injects the real bound port", () => {
    let boundPort = 0;
    const host = new ChannelMcpHost(fakeRegistry(), () => `http://127.0.0.1:${boundPort || 0}`);

    // listen 前（端口未知）与 listen 后（拿到随机端口）都要在签发时取当下值。
    expect(issuedUrl(host, runInput("s1", null))).toMatch(/^http:\/\/127\.0\.0\.1:0\/v1\/mcp\/everroom\//);
    boundPort = 53399;
    expect(issuedUrl(host, runInput("s1", null))).toMatch(/^http:\/\/127\.0\.0\.1:53399\/v1\/mcp\/everroom\//);
  });

  it("reuses the token for the same session (Phase 2i 后无 Room 维度，不再按 Room 轮换)", () => {
    const host = new ChannelMcpHost(fakeRegistry(), "http://127.0.0.1:7654");

    const first = issuedUrl(host, runInput("s1", "room-a"));
    const again = issuedUrl(host, runInput("s1", "room-a"));
    expect(again).toBe(first);
    expect(first).toBe(`http://127.0.0.1:7654/v1/mcp/everroom/${tokenFrom(first)}`);

    // 同 session 恒复用同一 token：Room 维度已删除，不存在按 Room 轮换。
    const onceMore = issuedUrl(host, runInput("s1", "room-b"));
    expect(onceMore).toBe(first);
    expect(tokenFrom(onceMore)).toMatch(/^[0-9a-f]{32}$/);

    // token 在 TTL 内可解析（claude 适配器 loadSession 不更新 mcpServers）。
    expect(() => host.exchangeTrusted(tokenFrom(first), { jsonrpc: "2.0", method: "initialize", params: {} }))
      .not.toThrow();
  });

  it("serves document capabilities over the exchange", async () => {
    const host = new ChannelMcpHost(fakeRegistry(), "http://127.0.0.1:7654");
    const token = tokenFrom(issuedUrl(host, runInput("s1", "room-a")));

    const init = await rpc(host, token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "1" },
    });
    expect(init[0]?.result).toMatchObject({ serverInfo: { name: "everroom-tools" } });

    const listed = await rpc(host, token, "tools/list");
    const names = (listed[0]?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(names).toContain("document_read");

    const docCall = await rpc(host, token, "tools/call", {
      name: "document_read",
      arguments: { ref: "notes/a.md" },
    });
    expect(docCall[0]?.result).toMatchObject({ content: [{ type: "text", text: "doc:notes/a.md" }] });

    await host.close();
  });

  it("reports unknown tools as tool errors instead of transport errors", async () => {
    const host = new ChannelMcpHost(fakeRegistry(), "http://127.0.0.1:7654");
    const token = tokenFrom(issuedUrl(host, runInput("s2", null)));
    await rpc(host, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } });

    const response = await rpc(host, token, "tools/call", { name: "nope", arguments: {} });
    expect(response[0]?.result).toMatchObject({ isError: true });
    await host.close();
  });

  it("rejects invalid tokens and messages before initialize", async () => {
    const host = new ChannelMcpHost(fakeRegistry(), "http://127.0.0.1:7654");
    await expect(host.exchangeTrusted("deadbeef".repeat(4), { jsonrpc: "2.0", method: "initialize", params: {} }))
      .rejects.toThrow("MCP_SESSION_INVALID");

    const token = tokenFrom(issuedUrl(host, runInput("s3", null)));
    await expect(rpc(host, token, "tools/list"))
      .rejects.toThrow("MCP_SESSION_INVALID");
    await host.close();
  });

  it("revokes tokens on agent session deletion", async () => {
    const host = new ChannelMcpHost(fakeRegistry(), "http://127.0.0.1:7654");
    const token = tokenFrom(issuedUrl(host, runInput("s4", null)));
    await rpc(host, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } });

    await host.revokeAgentSession("s4");
    await expect(host.exchangeTrusted(token, { jsonrpc: "2.0", id: ++nextId, method: "tools/list" }))
      .rejects.toThrow("MCP_SESSION_INVALID");
  });
});
