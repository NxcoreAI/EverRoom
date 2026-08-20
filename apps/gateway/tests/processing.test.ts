import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime, RuntimeEvent } from "@nxcore/agent-runtime";
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
    })).resolves.toEqual({ content: '{"title":"周会"}' });

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
});
