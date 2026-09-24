import { describe, expect, it } from "vitest";
import type { DocumentExecutionContext } from "../src/modules/documents/capabilities/types.js";
import type { DocumentCapabilityRegistry } from "../src/modules/documents/capabilities/registry.js";
import {
  ChannelMcpHost,
  channelToolsFromPiTools,
  channelToolsFromRuntimeTools,
  type ChannelMcpScope,
  type ChannelMcpTool,
} from "../src/modules/agent/channel-mcp-host.js";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";

function fakeRegistry(): DocumentCapabilityRegistry {
  return {
    listTools: () => [{
      name: "context_room_doc_read",
      title: "读取文档",
      description: "读取 Room 内文档",
      inputSchema: { type: "object", properties: { ref: { type: "string" } } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }],
    promptGuidelines: () => ["文档工具使用守则"],
    execute: async (name: string, args: Record<string, unknown>, _context: DocumentExecutionContext) => {
      if (name === "context_room_doc_read") {
        return { content: [{ type: "text", text: `doc:${String(args.ref)}` }] };
      }
      throw new Error(`METHOD_NOT_FOUND: Unknown tool ${name}`);
    },
  } as unknown as DocumentCapabilityRegistry;
}

function fakeKnowledgeTools(): (scope: ChannelMcpScope) => ChannelMcpTool[] {
  return (scope) => [{
    name: "memory_search",
    description: "检索记忆",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    execute: async (args) => ({ text: `memory:${String(args.query)}@${scope.roomId ?? "no-room"}`, isError: false }),
  }];
}

function runInput(sessionId: string, roomId: string | null): StartRuntimeRunInput {
  return {
    runId: `run-${sessionId}`,
    sessionId,
    runtimeSessionRef: null,
    prompt: "hi",
    pageLabel: "Agent",
    roomId,
  };
}

function tokenFrom(url: string): string {
  return url.split("/").pop() ?? "";
}

let nextId = 0;

async function rpc(host: ChannelMcpHost, token: string, method: string, params: Record<string, unknown> = {}) {
  const id = ++nextId;
  return await host.exchangeTrusted(token, { jsonrpc: "2.0", id, method, params });
}

describe("ChannelMcpHost", () => {
  it("reuses the token for the same session and room, rotates on room change", () => {
    const host = new ChannelMcpHost(fakeRegistry(), "http://127.0.0.1:7654");

    const first = host.mcpServersForRun(runInput("s1", "room-a"))[0];
    const again = host.mcpServersForRun(runInput("s1", "room-a"))[0];
    expect(again.url).toBe(first.url);
    expect(first.type).toBe("http");
    expect(first.name).toBe("everroom");
    expect(first.url).toBe(`http://127.0.0.1:7654/v1/mcp/everroom/${tokenFrom(first.url)}`);

    const rotated = host.mcpServersForRun(runInput("s1", "room-b"))[0];
    expect(rotated.url).not.toBe(first.url);
    expect(tokenFrom(rotated.url)).toMatch(/^[0-9a-f]{32}$/);

    // 旧 token 在 TTL 内仍可解析（claude 适配器 loadSession 不更新 mcpServers）。
    expect(() => host.exchangeTrusted(tokenFrom(first.url), { jsonrpc: "2.0", method: "initialize", params: {} }))
      .not.toThrow();
  });

  it("serves document capabilities and knowledge tools over the exchange", async () => {
    const host = new ChannelMcpHost(fakeRegistry(), "http://127.0.0.1:7654", fakeKnowledgeTools());
    const token = tokenFrom(host.mcpServersForRun(runInput("s1", "room-a"))[0].url);

    const init = await rpc(host, token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "1" },
    });
    expect(init[0]?.result).toMatchObject({ serverInfo: { name: "everroom-tools" } });

    const listed = await rpc(host, token, "tools/list");
    const names = (listed[0]?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(names).toContain("context_room_doc_read");
    expect(names).toContain("memory_search");

    const docCall = await rpc(host, token, "tools/call", {
      name: "context_room_doc_read",
      arguments: { ref: "notes/a.md" },
    });
    expect(docCall[0]?.result).toMatchObject({ content: [{ type: "text", text: "doc:notes/a.md" }] });

    const knowledgeCall = await rpc(host, token, "tools/call", {
      name: "memory_search",
      arguments: { query: "部署" },
    });
    expect(knowledgeCall[0]?.result).toMatchObject({ content: [{ type: "text", text: "memory:部署@room-a" }] });

    await host.close();
  });

  it("reports unknown tools as tool errors instead of transport errors", async () => {
    const host = new ChannelMcpHost(fakeRegistry(), "http://127.0.0.1:7654");
    const token = tokenFrom(host.mcpServersForRun(runInput("s2", null))[0].url);
    await rpc(host, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } });

    const response = await rpc(host, token, "tools/call", { name: "nope", arguments: {} });
    expect(response[0]?.result).toMatchObject({ isError: true });
    await host.close();
  });

  it("rejects invalid tokens and messages before initialize", async () => {
    const host = new ChannelMcpHost(fakeRegistry(), "http://127.0.0.1:7654");
    await expect(host.exchangeTrusted("deadbeef".repeat(4), { jsonrpc: "2.0", method: "initialize", params: {} }))
      .rejects.toThrow("MCP_SESSION_INVALID");

    const token = tokenFrom(host.mcpServersForRun(runInput("s3", null))[0].url);
    await expect(rpc(host, token, "tools/list"))
      .rejects.toThrow("MCP_SESSION_INVALID");
    await host.close();
  });

  it("revokes tokens on agent session deletion", async () => {
    const host = new ChannelMcpHost(fakeRegistry(), "http://127.0.0.1:7654");
    const token = tokenFrom(host.mcpServersForRun(runInput("s4", null))[0].url);
    await rpc(host, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } });

    await host.revokeAgentSession("s4");
    await expect(host.exchangeTrusted(token, { jsonrpc: "2.0", id: ++nextId, method: "tools/list" }))
      .rejects.toThrow("MCP_SESSION_INVALID");
  });
});

describe("channel tool adapters", () => {
  it("maps room runtime tools with a stable synthetic run id", async () => {
    const calls: Array<{ input: StartRuntimeRunInput; args: Record<string, unknown> }> = [];
    const tools = channelToolsFromRuntimeTools([{
      name: "room_context_get",
      description: "房间上下文",
      parameters: { type: "object", properties: {} },
      execute: async (input, args) => {
        calls.push({ input, args });
        return { content: "ctx-ok", isError: false } as never;
      },
    }], { agentSessionId: "s9", roomId: "room-z" });

    expect(tools[0]!.name).toBe("room_context_get");
    const result = await tools[0]!.execute({});
    expect(result).toMatchObject({ text: "ctx-ok", isError: false });
    expect(calls[0]!.input.runId).toBe("channel-mcp:s9");
    expect(calls[0]!.input.roomId).toBe("room-z");
  });

  it("maps pi knowledge tools, joining text blocks", async () => {
    const tools = channelToolsFromPiTools([{
      name: "wiki_search",
      description: "检索知识库",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      execute: (async (_id: string, params: unknown) => ({
        content: [
          { type: "text", text: "line-1" },
          { type: "text", text: "line-2" },
        ],
        isError: true,
      })) as never,
    }]);

    const result = await tools[0]!.execute({ query: "oidc" });
    expect(result).toEqual({ text: "line-1\nline-2", isError: true });
  });
});
