import type { FastifyBaseLogger } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryRuntimeConfig } from "@nxcore/agent-runtime-pi";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { MemoryService } from "../src/modules/memory/service.js";

const config: MemoryRuntimeConfig = {
  baseUrl: "http://127.0.0.1:8420",
  apiKey: "memory-key",
  serviceId: "everroom",
  teamId: "everroom",
  agentId: "pi-agent",
  userId: "local-user",
  recallLimit: 5,
  charBudget: 2_000,
};

const databases: DatabaseClient[] = [];
const temporaryDirectories: string[] = [];

function serviceWithCapture(assets: ConstructorParameters<typeof MemoryService>[2] = null) {
  const requests: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const data = url.endsWith("/v3/core/read")
      ? {
          content: "# Existing profile\n\n---\n## 🗺️ Scene Navigation (Scene Index)\nScene entries",
          version: 1,
          updated_at: "2026-08-19T00:00:00.000Z",
        }
      : {};
    return new Response(JSON.stringify({ code: 0, message: "ok", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;
  return { service: new MemoryService(config, logger, assets), requests, urls, fetchMock };
}

async function databaseForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-memory-onboarding-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  return { database, assets: { db: database.db, dataDir } };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

describe("document memory capture", () => {
  it("stores the Agent document creation fact without duplicating the full Markdown", async () => {
    const { service, requests } = serviceWithCapture();

    await expect(service.captureDocumentCreation({
      sessionId: "session-1",
      roomId: "room-1",
      documentId: "document-1",
      title: "认证服务演进路线",
      markdown: "# 第一章\n\n完整正文",
    })).resolves.toBe(true);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ session_id: "session-1" });
    const messages = requests[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("[document:create]");
    expect(messages[1]?.content).toContain("《认证服务演进路线》");
    expect(messages[1]?.content).not.toContain("# 第一章\n\n完整正文");
  });

  it("stores only the accepted selection rewrite result", async () => {
    const { service, requests } = serviceWithCapture();

    await expect(service.captureSelectionRewrite({
      roomId: "room-1",
      documentId: "document-1",
      documentTitle: "认证服务演进路线",
      instruction: "改得更简洁",
      originalText: "原始段落内容",
      replacementText: "精简后的段落",
    })).resolves.toBe(true);

    expect(requests[0]).toMatchObject({ session_id: "document:document-1" });
    const messages = requests[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("改写要求：改得更简洁");
    expect(messages[0]?.content).toContain("原始段落内容");
    expect(messages[1]?.content).toContain("精简后的段落");
  });

  it("does not fail document workflows when memory is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;
    const service = new MemoryService(null, logger, null);

    await expect(service.captureSelectionRewrite({
      roomId: "room-1",
      documentId: "document-1",
      documentTitle: "文档",
      instruction: "重写",
      originalText: "原文",
      replacementText: "新文",
    })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("memory onboarding capture", () => {
  it("writes one deterministic conversation and persists request idempotency", async () => {
    const { assets } = await databaseForTest();
    const { service, requests, urls } = serviceWithCapture(assets);
    const input = {
      requestId: "request-123",
      locale: "zh-CN" as const,
      workContext: "我负责桌面端产品研发",
      currentFocus: "完成首次使用体验",
      collaborationPreference: "先给结论，再说明风险",
    };

    const [first, concurrent] = await Promise.all([
      service.captureOnboarding(input),
      service.captureOnboarding(input),
    ]);
    const repeated = await service.captureOnboarding(input);

    expect(first).toEqual(concurrent);
    expect(repeated).toEqual(first);
    expect(first).toMatchObject({ sessionId: "onboarding:request-123", accepted: true });
    expect(urls).toEqual([
      "http://127.0.0.1:8420/v3/conversation/add",
      "http://127.0.0.1:8420/v3/core/read",
      "http://127.0.0.1:8420/v3/core/write",
    ]);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({ session_id: "onboarding:request-123" });
    const messages = requests[0]?.messages as Array<{ role: string; content: string; timestamp: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain("我的主要工作：我负责桌面端产品研发");
    expect(messages[0]?.content).toContain("我当前最想推进：完成首次使用体验");
    expect(messages[0]?.content).toContain("我希望 Agent 这样与我协作：先给结论，再说明风险");
    expect(messages[1]?.content).toContain("[everroom:onboarding:accepted]");
    expect(messages[0]?.timestamp).toBe(first.capturedAt);
    expect(messages[1]?.timestamp).toBe(first.capturedAt);
    const profile = requests[2]?.content as string;
    expect(profile).toContain("# Existing profile");
    expect(profile).toContain("## 首次协作画像");
    expect(profile).toContain("> 我负责桌面端产品研发");
    expect(profile).toContain("> 完成首次使用体验");
    expect(profile).toContain("> 先给结论，再说明风险");
    expect(profile.match(/everroom:onboarding-profile:start/g)).toHaveLength(1);
    expect(profile.indexOf("## 首次协作画像")).toBeLessThan(profile.indexOf("## 🗺️ Scene Navigation"));
  });

  it("recovers an interrupted accepted write by checking the fixed session before appending", async () => {
    const { database, assets } = await databaseForTest();
    const capturedAt = "2026-08-20T09:30:00.000Z";
    database.sqlite.prepare(
      "INSERT INTO gateway_metadata (key, value, updated_at) VALUES (?, ?, ?)",
    ).run(
      "memory.onboarding.v1:resume-1",
      JSON.stringify({
        status: "pending",
        sessionId: "onboarding:resume-1",
        capturedAt,
        accepted: true,
      }),
      Date.now(),
    );
    const { service, requests, urls, fetchMock } = serviceWithCapture(assets);
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const data = url.endsWith("/v3/conversation/query")
        ? { total: 2, messages: [{ id: "message-1" }] }
        : url.endsWith("/v3/core/read")
          ? { content: "# Existing profile", version: 1, updated_at: capturedAt }
          : {};
      return new Response(JSON.stringify({
        code: 0,
        message: "ok",
        data,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await expect(service.captureOnboarding({
      requestId: "resume-1",
      locale: "en-US",
      workContext: "Desktop product development",
      currentFocus: "First-run onboarding",
    })).resolves.toEqual({
      sessionId: "onboarding:resume-1",
      capturedAt,
      accepted: true,
    });

    expect(urls).toEqual([
      "http://127.0.0.1:8420/v3/conversation/query",
      "http://127.0.0.1:8420/v3/core/read",
      "http://127.0.0.1:8420/v3/core/write",
    ]);
    expect(requests[0]).toMatchObject({ session_id: "onboarding:resume-1", limit: 1, offset: 0 });
    const stored = database.sqlite.prepare(
      "SELECT value FROM gateway_metadata WHERE key = ?",
    ).get("memory.onboarding.v1:resume-1") as { value: string };
    const record = JSON.parse(stored.value) as { status: string; profileUpdated: boolean };
    expect(record.status).toBe("accepted");
    expect(record.profileUpdated).toBe(true);
  });

  it("rejects whitespace-only required answers before writing memory", async () => {
    const { service, fetchMock } = serviceWithCapture();
    await expect(service.captureOnboarding({
      requestId: "request-empty",
      locale: "en-US",
      workContext: "  ",
      currentFocus: "A real goal",
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
