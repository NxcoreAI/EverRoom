import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryRuntimeConfig } from "@nxcore/agent-runtime-pi";
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

function serviceWithCapture() {
  const requests: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ code: 0, message: "ok", data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;
  return { service: new MemoryService(config, logger), requests, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("document memory capture", () => {
  it("stores a committed Agent document with its final title and Markdown", async () => {
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
    expect(messages[1]?.content).toContain("# 第一章\n\n完整正文");
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
    const service = new MemoryService(null, logger);

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
