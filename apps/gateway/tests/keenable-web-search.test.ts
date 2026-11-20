import { describe, expect, it, vi } from "vitest";
import { createKeenableWebSearchPiTools } from "../src/modules/agent/keenable-web-search-tools.js";

const input = { runId: "run-1", sessionId: "session-1" } as never;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Keenable web_search tool", () => {
  it("uses the keyless public endpoint with the app title header", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [
        { title: "Apollo 11", url: "https://www.nasa.gov/apollo-11", snippet: "First crewed Moon landing." },
        { title: "No url" },
      ],
    }));
    const [tool] = createKeenableWebSearchPiTools({}, undefined, fetchImpl as typeof fetch);

    const result = await tool!.execute(input, { query: " apollo 11 " }, undefined);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.keenable.ai/v1/search/public");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "X-Keenable-Title": "EverRoom" });
    expect(init.headers).not.toHaveProperty("X-API-Key");
    expect(JSON.parse(String(init.body))).toEqual({ query: "apollo 11", max_results: 8 });
    expect(result.content).toBe("1. Apollo 11\nhttps://www.nasa.gov/apollo-11\nFirst crewed Moon landing.");
    expect(result.details).toEqual({ query: "apollo 11", provider: "keenable" });
  });

  it("uses the keyed endpoint when an API key is configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    const [tool] = createKeenableWebSearchPiTools({ apiKey: "key-1" }, undefined, fetchImpl as typeof fetch);

    const result = await tool!.execute(input, { query: "nothing" }, undefined);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.keenable.ai/v1/search");
    expect(init.headers).toMatchObject({ "X-API-Key": "key-1" });
    expect(init.headers).not.toHaveProperty("X-Keenable-Title");
    expect(result.content).toBe("没有找到相关结果。");
  });

  it("rejects empty queries and HTTP failures", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "rate limited" }, 429));
    const [tool] = createKeenableWebSearchPiTools({}, undefined, fetchImpl as typeof fetch);

    await expect(tool!.execute(input, { query: "  " }, undefined)).rejects.toThrow("query");
    await expect(tool!.execute(input, { query: "x" }, undefined)).rejects.toThrow("(429)");
  });

  it("goes through the external call budget", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    const budget = { execute: vi.fn(async (_s, _t, _c, invoke: (mark: () => void) => Promise<string>) => invoke(() => {})) };
    const [tool] = createKeenableWebSearchPiTools({}, budget as never, fetchImpl as typeof fetch);

    await tool!.execute(input, { query: "x" }, undefined);

    expect(budget.execute).toHaveBeenCalledWith("WEB_SEARCH", "web_search", {
      source: "agent",
      runId: "run-1",
      correlationId: "session-1",
    }, expect.any(Function));
  });
});
