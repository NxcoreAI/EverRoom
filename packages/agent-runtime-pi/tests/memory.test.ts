import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCoreClient, MemoryCoreError } from "../src/memory/client.js";
import { formatRecallResult } from "../src/memory/format.js";
import { createMemoryExtension, extractCapturableMessages } from "../src/memory/extension.js";
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
      {
        role: "user",
        content: "你好",
        timestamp: "2026-08-15T00:00:00.000Z",
        recordedAt: "2026-08-15T00:00:00.001Z",
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8420/v3/conversation/add");
    expect(JSON.parse(String(init.body)).messages[0]).toMatchObject({
      timestamp: "2026-08-15T00:00:00.000Z",
      recorded_at: "2026-08-15T00:00:00.001Z",
    });
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

describe("MemoryCoreClient browse APIs", () => {
  it("queryAtomic sends pagination and type filters", async () => {
    const fetchMock = mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ type: "persona", limit: 50, offset: 100 });
      return {
        status: 200,
        body: {
          code: 0,
          message: "ok",
          data: { items: [{ id: "a1", type: "persona", content: "喜欢深色主题", created_at: "", updated_at: "" }], total: 1 },
        },
      };
    });
    const client = new MemoryCoreClient(config);
    const page = await client.queryAtomic({ type: "persona", limit: 50, offset: 100 });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:8420/v3/atomic/query");
    expect(page.total).toBe(1);
    expect(page.items[0]!.content).toBe("喜欢深色主题");
  });

  it("updateAtomic and deleteAtomic hit the expected endpoints", async () => {
    const fetchMock = mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      return { status: 200, body: { code: 0, message: "ok", data: { id: body.id, version: 3, updated_at: "t", deleted_count: 2 } } };
    });
    const client = new MemoryCoreClient(config);
    await client.updateAtomic("a1", "新内容");
    await client.deleteAtomic(["a1", "a2"]);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/v3/atomic/update");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/v3/atomic/delete");
  });

  it("queryConversation returns messages with totals", async () => {
    mockFetch(() => ({
      status: 200,
      body: {
        code: 0,
        message: "ok",
        data: { messages: [{ id: "m1", role: "user", content: "hi", session_id: "s1" }], total: 42 },
      },
    }));
    const client = new MemoryCoreClient(config);
    const page = await client.queryConversation({ limit: 50, offset: 0 });
    expect(page.total).toBe(42);
    expect(page.messages[0]!.session_id).toBe("s1");
  });

  it("readScenario normalizes a missing file to null content", async () => {
    mockFetch(() => ({ status: 200, body: { code: 0, message: "ok", data: { content: null } } }));
    const client = new MemoryCoreClient(config);
    const file = await client.readScenario("工作/综述.md");
    expect(file.path).toBe("工作/综述.md");
    expect(file.content).toBeNull();
  });

  it("writeCore and count endpoints return normalized data", async () => {
    mockFetch(() => ({ status: 200, body: { code: 0, message: "ok", data: { version: 2, updated_at: "t", total: 7 } } }));
    const client = new MemoryCoreClient(config);
    await expect(client.writeCore("# 画像")).resolves.toEqual({ version: 2, updated_at: "t" });
    await expect(client.countAtomic()).resolves.toBe(7);
    await expect(client.countScenario()).resolves.toBe(7);
    await expect(client.countConversation()).resolves.toBe(7);
  });

  it("pipelineStatus reads /v2/pipeline/status", async () => {
    const fetchMock = mockFetch(() => ({
      status: 200,
      body: {
        code: 0,
        message: "ok",
        data: { l1: { queued: 1, running: 0, queued_sessions: ["s"], running_sessions: [], idle: false } },
      },
    }));
    const client = new MemoryCoreClient(config);
    const status = await client.pipelineStatus();
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:8420/v2/pipeline/status");
    expect(status.l1.queued).toBe(1);
  });

  it("classifies network failures as unreachable MemoryCoreError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }));
    const client = new MemoryCoreClient(config);
    const error = await client.countAtomic().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MemoryCoreError);
    expect((error as MemoryCoreError).kind).toBe("unreachable");
  });

  it("classifies envelope failures as api MemoryCoreError", async () => {
    mockFetch(() => ({ status: 200, body: { code: 500, message: "boom" } }));
    const client = new MemoryCoreClient(config);
    const error = await client.countAtomic().catch((cause: unknown) => cause);
    expect((error as MemoryCoreError).kind).toBe("api");
    expect((error as MemoryCoreError).status).toBe(500);
  });
});

describe("MemoryCoreClient connection retry", () => {
  it("retries through a MemoryCore restart window and succeeds", async () => {
    const client = new MemoryCoreClient(config);
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("fetch failed");
      return new Response(JSON.stringify({ code: 0, message: "ok", data: { total: 3 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const count = await client.countAtomic();
    expect(count).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("reports unreachable after the retry window is exhausted", async () => {
    const client = new MemoryCoreClient(config);
    const fetchMock = vi.fn(async () => { throw new Error("fetch failed"); });
    vi.stubGlobal("fetch", fetchMock);
    await expect(client.countAtomic()).rejects.toMatchObject({ kind: "unreachable" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("does not retry non-connection errors (abort/timeout)", async () => {
    const client = new MemoryCoreClient(config);
    const fetchMock = vi.fn(async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(client.countAtomic()).rejects.toMatchObject({ kind: "unreachable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
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
        conversationHits: [{
          role: "assistant",
          content: "[document:doc-1] 认证服务演进路线\n\n旧文档正文",
          timestamp: "2026-08-03T10:00:00Z",
        }],
      },
      2000,
    );
    expect(result).toContain("<memory-context>");
    expect(result).toContain("[用户画像]");
    expect(result).toContain("用户偏好中文回复");
    expect(result).toContain("工作.md");
    expect(result).toContain("[相关历史对话与文档]");
    expect(result).toContain("认证服务演进路线");
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

  it("renders the Room memories section outside the character budget", () => {
    const roomContent = "R".repeat(300);
    const globalContent = "G".repeat(500);
    const result = formatRecallResult(
      {
        atomicItems: [{ id: "a", type: "t", content: globalContent, created_at: "", updated_at: "" }],
        coreContent: null,
        scenarios: [],
        roomMemories: [{ memoryId: "m1", type: "fact", content: roomContent, updatedAt: "2026-09-01T00:00:00Z" }],
      },
      200,
    );
    expect(result).toContain("[Room 记忆]");
    expect(result).toContain("用户为当前 Context Room 甄选");
    expect(result).toContain(roomContent);
    expect(result).toContain("（fact）");
    expect(result).toContain("[2026-09-01]");
    expect(result).toContain("已截断");
    // Room 段完整保留在截断之前。
    expect(result!.indexOf("[Room 记忆]")).toBeLessThan(result!.indexOf("已截断"));
    expect(result!.indexOf(roomContent)).toBeLessThan(result!.indexOf("已截断"));
  });

  it("returns room-only recall when all global paths are empty", () => {
    const result = formatRecallResult(
      {
        atomicItems: [],
        coreContent: null,
        scenarios: [],
        roomMemories: [{ memoryId: "m", type: "", content: "Room 甄选记忆", updatedAt: "" }],
      },
      2000,
    );
    expect(result).toContain("[Room 记忆]");
    expect(result).toContain("Room 甄选记忆");
    expect(result).not.toContain("[相关记忆]");
  });

  it("omits the room section when roomMemories is empty or absent", () => {
    const withEmpty = formatRecallResult(
      { atomicItems: [], coreContent: "画像", scenarios: [], roomMemories: [] },
      2000,
    );
    expect(withEmpty).not.toContain("[Room 记忆]");
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

describe("memory extension capture policy", () => {
  it("recalls memory but skips automatic capture for deferred preview runs", async () => {
    const client = new MemoryCoreClient(config);
    const searchAtomic = vi.spyOn(client, "searchAtomic").mockResolvedValue([]);
    const readCore = vi.spyOn(client, "readCore").mockResolvedValue(null);
    const listScenarios = vi.spyOn(client, "listScenarios").mockResolvedValue([]);
    const searchConversation = vi.spyOn(client, "searchConversation").mockResolvedValue([]);
    const addConversation = vi.spyOn(client, "addConversation").mockResolvedValue();
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
    const extension = createMemoryExtension({
      client,
      config,
      getRunContext: () => ({
        sessionId: "rewrite-preview",
        originalPrompt: "把选区改得更简洁",
        pageLabel: "AI 重写",
        cancelled: false,
        captureEnabled: false,
        recallEnabled: true,
      }),
    });
    if (!("factory" in extension)) throw new Error("Expected an inline extension object");
    extension.factory({
      on: (event: string, handler: (event: unknown) => Promise<unknown>) => {
        handlers.set(event, handler);
      },
    } as never);

    await handlers.get("before_agent_start")?.({});
    await handlers.get("agent_end")?.({
      messages: [
        { role: "user", content: "把选区改得更简洁" },
        { role: "assistant", content: "改写后的预览内容" },
      ],
    });

    expect(searchAtomic).toHaveBeenCalled();
    expect(readCore).toHaveBeenCalled();
    expect(listScenarios).toHaveBeenCalled();
    expect(searchConversation).toHaveBeenCalledWith("把选区改得更简洁", 5);
    expect(addConversation).not.toHaveBeenCalled();
  });

  it("skips automatic recall when recall is disabled", async () => {
    const client = new MemoryCoreClient(config);
    const searchAtomic = vi.spyOn(client, "searchAtomic").mockResolvedValue([]);
    const readCore = vi.spyOn(client, "readCore").mockResolvedValue(null);
    const listScenarios = vi.spyOn(client, "listScenarios").mockResolvedValue([]);
    const searchConversation = vi.spyOn(client, "searchConversation").mockResolvedValue([]);
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
    const extension = createMemoryExtension({
      client,
      config,
      getRunContext: () => ({
        sessionId: "cursor-completion",
        originalPrompt: "补全文档",
        pageLabel: "AI 补全",
        cancelled: false,
        captureEnabled: false,
        recallEnabled: false,
      }),
    });
    if (!("factory" in extension)) throw new Error("Expected an inline extension object");
    extension.factory({
      on: (event: string, handler: (event: unknown) => Promise<unknown>) => {
        handlers.set(event, handler);
      },
    } as never);

    await handlers.get("before_agent_start")?.({});

    expect(searchAtomic).not.toHaveBeenCalled();
    expect(readCore).not.toHaveBeenCalled();
    expect(listScenarios).not.toHaveBeenCalled();
    expect(searchConversation).not.toHaveBeenCalled();
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
    expect(searchSpy).toHaveBeenCalledWith("用户在哪", 5, undefined);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("用户在上海");
    expect(text).toContain("[2026-08-10]");
  });

  it("memory_search forwards time range and renders scene_name", async () => {
    const client = new MemoryCoreClient(config);
    const searchSpy = vi.spyOn(client, "searchAtomic").mockResolvedValue([
      {
        id: "a1",
        type: "fact",
        content: "镜像来自内部仓库",
        scene_name: "EverRoom 部署手册",
        background: "EverRoom 部署手册",
        created_at: "",
        updated_at: "2026-08-12T00:00:00Z",
      },
    ]);
    const [tool] = createMemoryTools(client, () => "sess-1");
    const result = await tool!.execute(
      "call-scene",
      { query: "镜像仓库", time_start: "2026-08-01T00:00:00Z" },
      undefined,
      undefined,
      {} as never,
    );
    expect(searchSpy).toHaveBeenCalledWith("镜像仓库", 5, { start: "2026-08-01T00:00:00Z", end: undefined });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("（场景：EverRoom 部署手册）");
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

  it("memory_search routes to the room provider when room_id is set", async () => {
    const client = new MemoryCoreClient(config);
    const searchSpy = vi.spyOn(client, "searchAtomic").mockResolvedValue([]);
    const roomSearch = vi.fn(async (_roomId: string, _query: string, _limit: number) => [
      { id: "m1", type: "fact", content: "Room 绑定记忆", created_at: "", updated_at: "2026-09-01T00:00:00Z" },
    ]);
    const [tool] = createMemoryTools(client, () => "sess-1", roomSearch);
    const result = await tool!.execute("call-room", { query: "绑定", room_id: "room-a" }, undefined, undefined, {} as never);
    expect(roomSearch).toHaveBeenCalledWith("room-a", "绑定", 5);
    expect(searchSpy).not.toHaveBeenCalled();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("Room 绑定记忆");
    expect(text).toContain("[2026-09-01]");
  });

  it("memory_search applies the time range locally on the room path", async () => {
    const client = new MemoryCoreClient(config);
    const roomSearch = vi.fn(async () => [
      { id: "m1", type: "fact", content: "九月的记忆", created_at: "", updated_at: "2026-09-01T00:00:00Z" },
      { id: "m2", type: "fact", content: "八月的记忆", created_at: "", updated_at: "2026-08-01T00:00:00Z" },
    ]);
    const [tool] = createMemoryTools(client, () => "sess-1", roomSearch);
    const result = await tool!.execute(
      "call-room-range",
      { query: "记忆", room_id: "room-a", time_start: "2026-08-15T00:00:00Z" },
      undefined,
      undefined,
      {} as never,
    );
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("九月的记忆");
    expect(text).not.toContain("八月的记忆");
  });

  it("memory_search reports an unavailable room filter without a provider", async () => {
    const client = new MemoryCoreClient(config);
    const [tool] = createMemoryTools(client, () => "sess-1");
    const result = await tool!.execute("call-room-noop", { query: "绑定", room_id: "room-a" }, undefined, undefined, {} as never);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("Room 记忆过滤未配置");
  });
});
