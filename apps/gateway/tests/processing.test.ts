import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime, RuntimeEvent } from "@nxcore/agent-runtime";
import { SessionTitleService } from "../src/modules/processing/session-title.js";
import { TranscriptionSummaryService } from "../src/modules/processing/service.js";

async function* events(): AsyncIterable<RuntimeEvent> {
  yield { type: "run.started", payload: {} };
  yield { type: "message.completed", payload: { content: '{"title":"周会"}' } };
  yield { type: "run.completed", payload: {} };
}

describe("TranscriptionSummaryService", () => {
  it("uses an isolated runtime session and returns only the completed Agent content", async () => {
    const runtime = {
      start: vi.fn(async () => ({ runId: "run", runtimeSessionRef: "/tmp/background-session", events: events() })),
      deleteSession: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    } as unknown as AgentRuntime;
    const service = new TranscriptionSummaryService(runtime);

    await expect(service.summarize({
      jobId: "job-1",
      sourceRecordId: "source-1",
      transcript: "这是待总结的转写内容。",
    })).resolves.toEqual({ content: '{"title":"周会","eventType":"OTHER","actionItems":[],"representativeTags":[]}' });

    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "transcription-summary:job-1",
      pageLabel: "后台转写总结",
      runtimeSessionRef: null,
      captureMemory: false,
    }));
    const prompt = (runtime.start as ReturnType<typeof vi.fn>).mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("使用 transcription-memory-reconstruction Skill")
    expect(prompt).toContain("很短的转写")
    expect(prompt).toContain("<transcript>")
    expect(readFileSync(resolve("../../agents/transcription-summary/skills/transcription-memory-reconstruction/SKILL.md"), "utf8"))
      .toContain("representativeTags");
    expect(runtime.deleteSession).toHaveBeenCalledWith("/tmp/background-session");
  });

  it("asks for proportionally detailed coverage when the transcript is long", async () => {
    const runtime = {
      start: vi.fn(async () => ({ runId: "run", runtimeSessionRef: "/tmp/background-session", events: events() })),
      deleteSession: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    } as unknown as AgentRuntime;
    const service = new TranscriptionSummaryService(runtime);

    await service.summarize({
      jobId: "job-long",
      sourceRecordId: "source-long",
      transcript: "包含人物、背景、讨论、决定与后续安排的有效转写。".repeat(200),
    });

    const prompt = (runtime.start as ReturnType<typeof vi.fn>).mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("这是一份长转写")
    expect(prompt).toContain("700 至 1500 个中文字符")
    expect(prompt).toContain("10 至 18 条")
  });

  it("requests a substantial memory reconstruction for a medium transcript", async () => {
    const runtime = {
      start: vi.fn(async () => ({ runId: "run", runtimeSessionRef: "/tmp/background-session", events: events() })),
      deleteSession: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    } as unknown as AgentRuntime;
    const service = new TranscriptionSummaryService(runtime);

    await service.summarize({
      jobId: "job-medium",
      sourceRecordId: "source-medium",
      transcript: "这是一段包含背景、过程、讨论、理由和后续安排的有效转写。".repeat(20),
    });

    const prompt = (runtime.start as ReturnType<typeof vi.fn>).mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("这是一份中等长度转写")
    expect(prompt).toContain("250 至 700 个中文字符")
    expect(prompt).toContain("6 至 12 条")
    expect(prompt).toContain("250 至 700 个中文字符")
  });

  it("uses chunk extraction and a final synthesis for long transcripts", async () => {
    const runtime = {
      start: vi.fn(async () => ({ runId: "run", runtimeSessionRef: "/tmp/background-session", events: events() })),
      deleteSession: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    } as unknown as AgentRuntime;
    const service = new TranscriptionSummaryService(runtime);

    await service.summarize({
      jobId: "job-very-long",
      sourceRecordId: "source-very-long",
      transcript: Array.from({ length: 40 }, (_, index) => `[${String(index).padStart(2, "0")}:00] 发言人：第 ${index} 段包含决定、行动项和背景信息。`.repeat(35)).join("\n"),
    });

    const calls = (runtime.start as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(2);
    expect(calls[0]![0].prompt).toContain("这是第 1/");
    expect(calls.at(-1)![0].prompt).toContain("全篇记忆重建");
    expect(calls.at(-1)![0].prompt).toContain("partial-summaries");
    expect(runtime.deleteSession).toHaveBeenCalledTimes(calls.length);
  });
});

function fakeRuntime(content: string) {
  async function* events(): AsyncIterable<RuntimeEvent> {
    yield { type: "message.completed", payload: { content } };
    yield { type: "run.completed", payload: {} };
  }
  return {
    start: vi.fn(async () => ({ runId: "run", runtimeSessionRef: "/tmp/title-session", events: events() })),
    deleteSession: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  } as unknown as AgentRuntime;
}

describe("SessionTitleService", () => {
  it("runs a tools-disabled one-shot and returns the normalized title", async () => {
    const runtime = fakeRuntime("「EverRoom 导出排障」.");
    const service = new SessionTitleService(runtime);

    await expect(service.generate({
      sessionId: "session-1",
      userText: "帮我看下导出失败的原因",
      assistantText: "导出失败是因为……",
      language: "zh-CN",
    })).resolves.toEqual({ title: "EverRoom 导出排障" });

    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-title:session-1",
      pageLabel: "会话标题生成",
      runtimeSessionRef: null,
      toolsEnabled: false,
      captureMemory: false,
      recallMemory: false,
      responseLanguage: "zh-CN",
    }));
    const prompt = (runtime.start as ReturnType<typeof vi.fn>).mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("<user_message>");
    expect(prompt).toContain("帮我看下导出失败的原因");
    expect(prompt).toContain("<assistant_reply>");
    expect(prompt).toContain("输出语言：zh-CN");
    expect(runtime.deleteSession).toHaveBeenCalledWith("/tmp/title-session");
  });

  it("strips code fences and caps title length", async () => {
    const runtime = fakeRuntime("```\n这是一个特别特别特别特别特别长的标题文本超过四十八个字符会被截断处理掉\n```");
    const service = new SessionTitleService(runtime);
    const { title } = await service.generate({
      sessionId: "session-2",
      userText: "问个问题",
      assistantText: "回答",
    });
    expect(title.startsWith("```")).toBe(false);
    expect(title.length).toBeLessThanOrEqual(48);
  });

  it("throws on empty model output", async () => {
    const runtime = fakeRuntime("   ");
    const service = new SessionTitleService(runtime);
    await expect(service.generate({
      sessionId: "session-3",
      userText: "问个问题",
      assistantText: "回答",
    })).rejects.toThrow("empty content");
  });

  it("throws when runtime is unavailable", async () => {
    const service = new SessionTitleService(null);
    await expect(service.generate({
      sessionId: "session-4",
      userText: "问个问题",
      assistantText: "回答",
    })).rejects.toThrow("title_runtime_unavailable");
  });
});
