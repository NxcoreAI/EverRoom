import { describe, expect, it } from "vitest";
import { parseDiaryAgentOutput } from "../src/modules/diary/agent-generator.js";

const payload = {
  headline: "一天",
  summary: "完成了调试。",
  reflection: "过程清晰。",
  range: { start: "2026-08-20T00:00:00.000Z", end: "2026-08-20T12:00:00.000Z" },
  events: [{
    time: "2026-08-20T08:00:00.000Z",
    title: "调试",
    summary: "修复了 {JSON} 输出。",
    sourceRefs: ["file:file-1"],
  }],
  closing: "今天告一段落。",
};

describe("Diary Agent output parser", () => {
  it("accepts a direct JSON object and a fenced JSON object", () => {
    expect(parseDiaryAgentOutput(JSON.stringify(payload))).toMatchObject({ mode: "direct", payload });
    expect(parseDiaryAgentOutput(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``)).toMatchObject({ mode: "direct", payload });
  });

  it("extracts a complete diary object after model explanation text", () => {
    const output = `我先读取几个关键来源。\n{not-json}\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n整理完成。`;
    expect(parseDiaryAgentOutput(output)).toMatchObject({ mode: "embedded", payload });
  });

  it("does not accept unrelated JSON objects", () => {
    expect(() => parseDiaryAgentOutput('说明 {"sourceId":"file:file-1"}')).toThrow("Diary Agent returned invalid JSON");
  });

  it("returns a stable error without including model output", () => {
    const privateOutput = "用户的私人正文";
    expect(() => parseDiaryAgentOutput(privateOutput)).toThrowError(new Error("Diary Agent returned invalid JSON"));
  });
});
