import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "@nxcore/agent-runtime";

export interface TranscriptionSummaryInput {
  jobId: string;
  sourceRecordId: string;
  transcript: string;
  language?: string;
}

export interface TranscriptionSummaryOutput {
  content: string;
}

export class TranscriptionSummaryService {
  private readonly activeJobs = new Set<string>();

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly disposeRuntime = true,
  ) {}

  async summarize(input: TranscriptionSummaryInput): Promise<TranscriptionSummaryOutput> {
    if (this.activeJobs.has(input.jobId)) throw new Error("summary_job_busy");
    this.activeJobs.add(input.jobId);
    const sessionId = `transcription-summary:${input.jobId}`;
    const runId = randomUUID();
    let runtimeSessionRef: string | null = null;
    try {
      const run = await this.runtime.start({
        runId,
        sessionId,
        runtimeSessionRef: null,
        pageLabel: "后台转写总结",
        roomId: null,
        captureMemory: false,
        prompt: summaryPrompt(input),
      });
      runtimeSessionRef = run.runtimeSessionRef;
      let content = "";
      for await (const event of run.events) {
        if (event.type === "message.completed") {
          const value = (event.payload as { content?: unknown }).content;
          if (typeof value === "string") content = value;
        }
        if (event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.interrupted") {
          const message = (event.payload as { message?: unknown }).message;
          throw new Error(typeof message === "string" ? message : "Background Agent run failed");
        }
      }
      if (!content.trim()) throw new Error("Background Agent returned an empty summary");
      return { content };
    } finally {
      this.activeJobs.delete(input.jobId);
      if (runtimeSessionRef) await this.runtime.deleteSession(runtimeSessionRef).catch(() => undefined);
    }
  }

  dispose(): Promise<void> {
    return this.disposeRuntime ? this.runtime.dispose() : Promise.resolve();
  }
}

function summaryPrompt(input: TranscriptionSummaryInput): string {
  const transcriptLength = input.transcript.trim().length;
  const detailGuidance = transcriptLength > 5_000
    ? "这是一份超长转写。overview 通常写 1500 至 3500 个中文字符，keyPoints 在信息充足时有 15 至 30 条。"
    : transcriptLength > 1_500
      ? "这是一份长转写。overview 通常写 700 至 1500 个中文字符，keyPoints 在信息充足时有 10 至 18 条。"
      : transcriptLength > 300
        ? "这是一份中等长度转写。overview 通常写 250 至 700 个中文字符，keyPoints 在信息充足时有 6 至 12 条。"
        : "这是一份很短的转写。overview 完整表达全部有效信息，通常写 80 至 180 个中文字符，keyPoints 在信息充足时有 2 至 5 条。";
  return [
    "使用 transcription-memory-reconstruction Skill 完成记忆重建。",
    detailGuidance,
    `输出语言：${input.language || "zh-CN"}。`,
    `源记录：${input.sourceRecordId}`,
    "<transcript>",
    input.transcript,
    "</transcript>",
  ].join("\n");
}
