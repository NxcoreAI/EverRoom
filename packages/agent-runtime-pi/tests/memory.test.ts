import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCoreClient } from "../src/memory/client.js";
import { formatRecallResult } from "../src/memory/format.js";
import { extractCapturableMessages } from "../src/memory/extension.js";
import { createMemoryTools } from "../src/memory/tools.js";
import type { MemoryRuntimeConfig } from "../src/memory/types.js";

const config: MemoryRuntimeConfig = {
  baseUrl: "http://127.0.0.1:8420",
  apiKey: "test-key",
  serviceId: "everroom",
  teamId: "everroom",
  agentId: "pi-agent",
  userId: "local-user",
  recallLimit: 5,
  charBudget: 2000,
};

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MemoryCoreClient", () => {
  it("sends isolation body and service headers on conversation add", async () => {
    const fetchMock = mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        team_id: "everroom",
        agent_id: "pi-agent",
        user_id: "local-user",
        session_id: "sess-1",
      });
      expect(body.messages).toHaveLength(1);
      return { status: 200, body: { code: 0, message: "ok", data: { accepted_ids: ["m1"], total_count: 1 } } };
    });
    const client = new MemoryCoreClient(config);
    await client.addConversation("sess-1", [
      { role: "user", content: "你好", timestamp: "2026-08-15T00:00:00.000Z" },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8420/v3/conversation/add");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-tdai-service-id"]).toBe("everroom");
    expect(headers.authorization).toBe("Bearer test-key");
  });

  it("omits authorization header when no api key is configured", async () => {
    const fetchMock = mockFetch(() => ({
      status: 200,
      body: { code: 0, message: "ok", data: { items: [] } },
    }));
    const client = new MemoryCoreClient({ ...config, apiKey: "" });
    await client.searchAtomic("query", 5);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("throws on envelope error code", async () => {
    mockFetch(() => ({ status: 200, body: { code: 401, message: "unauthorized" } }));
    const client = new MemoryCoreClient(config);
    await expect(client.searchAtomic("query", 5)).rejects.toThrow("code=401");
  });

  it("throws on non-2xx http status", async () => {
    mockFetch(() => ({ status: 503, body: { code: 0, message: "ok" } }));
    const client = new MemoryCoreClient(config);
    await expect(client.readCore()).rejects.toThrow("HTTP 503");
  });

  it("returns empty arrays for missing data fields", async () => {
    mockFetch(() => ({ status: 200, body: { code: 0, message: "ok", data: {} } }));
    const client = new MemoryCoreClient(config);
    await expect(client.searchAtomic("q", 5)).resolves.toEqual([]);
    await expect(client.listScenarios()).resolves.toEqual([]);
  });

  it("returns null core when content is not generated yet", async () => {
    mockFetch(() => ({
      status: 200,
      body: { code: 0, message: "ok", data: { content: null, updated_at: null } },
    }));
    const client = new MemoryCoreClient(config);
    await expect(client.readCore()).resolves.toBeNull();
  });
});

describe("formatRecallResult", () => {
  it("returns null when nothing was recalled", () => {
    expect(formatRecallResult({ atomicItems: [], coreContent: null, scenarios: [] }, 2000)).toBeNull();
  });

  it("includes persona, atomic memories and scenario directory", () => {
    const result = formatRecallResult(
      {
        atomicItems: [
          {
            id: "a1",
            type: "preference",
            content: "用户偏好中文回复",
            created_at: "2026-08-01T00:00:00Z",
            updated_at: "2026-08-02T00:00:00Z",
          },
        ],
        coreContent: "用户是桌面应用开发者",
        scenarios: [{ path: "工作.md", created_at: "", updated_at: "" }],
      },
      2000,
    );
    expect(result).toContain("<memory-context>");
    expect(result).toContain("[用户画像]");
    expect(result).toContain("用户偏好中文回复");
    expect(result).toContain("工作.md");
    expect(result).toContain("[2026-08-02]");
  });

  it("truncates to the character budget", () => {
    const long = "x".repeat(500);
    const result = formatRecallResult(
      { atomicItems: [{ id: "a", type: "t", content: long, created_at: "", updated_at: "" }], coreContent: null, scenarios: [] },
      200,
    );
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThan(300);
    expect(result).toContain("已截断");
  });
});

describe("extractCapturableMessages", () => {
  const run = { originalPrompt: "帮我看看鉴权模块", pageLabel: "项目A" };

  it("replaces the wrapped user prompt with the original request", () => {
    const messages = extractCapturableMessages(
      [
        { role: "user", content: "当前工作区：项目A\n\n用户请求：帮我看看鉴权模块", timestamp: 1 },
        { role: "assistant", content: "好的，鉴权模块的情况是……", timestamp: 2 },
      ],
      run,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("[workspace: 项目A] 帮我看看鉴权模块");
    expect(messages[1]!.role).toBe("assistant");
  });

  it("drops custom, toolResult and thinking-only entries", () => {
    const messages = extractCapturableMessages(
      [
        { role: "user", content: "原始请求", timestamp: 1 },
        { role: "custom", customType: "memory-recall", content: "<memory-context>…</memory-context>", display: false, timestamp: 2 },
        { role: "toolResult", content: [{ type: "text", text: "tool output" }], timestamp: 3 },
        { role: "assistant", content: [{ type: "thinking", text: "思考中" }, { type: "text", text: "这是正式回复内容" }], timestamp: 4 },
      ],
      run,
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content).toBe("这是正式回复内容");
  });

  it("filters ultra-short assistant replies but keeps the user turn", () => {
    const messages = extractCapturableMessages(
      [
        { role: "user", content: "继续", timestamp: 1 },
        { role: "assistant", content: "好", timestamp: 2 },
      ],
      { originalPrompt: "继续", pageLabel: "项目A" },
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
  });

  it("returns empty when no user/assistant text is present", () => {
    expect(extractCapturableMessages([{ role: "custom", customType: "x", content: "c", display: true, timestamp: 1 }], run)).toEqual([]);
  });
});

describe("memory tools", () => {
  it("memory_search formats atomic hits", async () => {
    const client = new MemoryCoreClient(config);
    const searchSpy = vi.spyOn(client, "searchAtomic").mockResolvedValue([
      { id: "a1", type: "fact", content: "用户在上海", created_at: "", updated_at: "2026-08-10T00:00:00Z" },
    ]);
    const [tool] = createMemoryTools(client, () => "sess-1");
    expect(tool!.name).toBe("memory_search");
    const result = await tool!.execute("call-1", { query: "用户在哪" }, undefined, undefined, {} as never);
    expect(searchSpy).toHaveBeenCalledWith("用户在哪", 5);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("用户在上海");
    expect(text).toContain("[2026-08-10]");
  });

  it("conversation_search passes session id only when scoped to current session", async () => {
    const client = new MemoryCoreClient(config);
    const searchSpy = vi
      .spyOn(client, "searchConversation")
      .mockResolvedValue([{ role: "user", content: "之前说过别动鉴权", timestamp: "2026-08-01T10:00:00Z" }]);
    const [, tool] = createMemoryTools(client, () => "sess-1");
    await tool!.execute("call-2", { query: "鉴权", current_session_only: true }, undefined, undefined, {} as never);
    expect(searchSpy).toHaveBeenLastCalledWith("鉴权", 5, "sess-1");
    await tool!.execute("call-3", { query: "鉴权" }, undefined, undefined, {} as never);
    expect(searchSpy).toHaveBeenLastCalledWith("鉴权", 5, undefined);
  });

  it("returns error text instead of throwing when the service is down", async () => {
    const client = new MemoryCoreClient(config);
    vi.spyOn(client, "searchAtomic").mockRejectedValue(new Error("connection refused"));
    const [tool] = createMemoryTools(client, () => undefined);
    const result = await tool!.execute("call-4", { query: "q" }, undefined, undefined, {} as never);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("记忆检索失败");
  });
});
