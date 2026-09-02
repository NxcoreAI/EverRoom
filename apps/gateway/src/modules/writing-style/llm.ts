import type { AgentRuntime } from "@nxcore/agent-runtime";
import { randomUUID } from "node:crypto";
import { invokeRuntime } from "../agent/invoke.js";
import type { SupportedToken } from "./analyzer.js";

/** LLM 定性层产物（方案 §6：语气/口头禅/偏好 do-dont/一句话画像）。 */
export interface WritingStyleQualitative {
  tone: string[];
  phrases: string[];
  preferences: { do: string[]; dont: string[] };
  summary: string;
}

export interface WritingStyleBehaviorEvidence {
  instructionCounts: Array<{ label: string; count: number }>;
  instructionSamples: Array<{ category: string | null; instruction: string }>;
  revisionCount: number;
  averageLenDeltaRatio: number | null;
  exclamationDelta: number;
  revisionSamples: Array<{ before: string; after: string }>;
  /** 审阅层拒绝统计（review_decision 信号）：拒绝/接受的提案项数与拒绝摘录。 */
  reviewRejectedCount: number;
  reviewAcceptedCount: number;
  reviewSamples: string[];
}

export interface WritingStyleEvidence {
  /** 聚合统计的派生摘要行（三维度）。 */
  sections: { vocabulary: string[]; sentence: string[]; structure: string[] };
  supportedTokens: SupportedToken[];
  sketchCount: number;
  charCount: number;
  /** 采样证据行（已按调用方截断）。 */
  evidenceLines: string[];
  /** 行为信号（§4 扩展）：指令归类 + 用户手改 agent 输出的方向统计。 */
  behavior?: WritingStyleBehaviorEvidence;
}

export class WritingStyleLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WritingStyleLlmError";
  }
}

const CHAT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_CHARS = 8_000;
const MAX_ITEM_LENGTH = 60;
const MAX_ARRAY_ITEMS = 6;

const OUTPUT_CONTRACT = [
  "输出一个 JSON 对象（不要 Markdown 围栏、解释或额外字段），结构：",
  '{"tone": string[], "phrases": string[], "preferences": {"do": string[], "dont": string[]}, "summary": string}',
  "tone=语气特征（≤4 条）；phrases=高频口头禅/惯用语（≤5 条）；do/dont=表达偏好（各 ≤4 条，短句祈使式）；summary=一句话画像（≤60 字）。",
  "硬约束：只陈述下方统计与采样证据能支撑的结论；某类证据不足时对应数组返回空、summary 返回空串；禁止推断职业、身份等统计以外的信息；全部用中文。",
].join("\n");

function buildPrompt(input: WritingStyleEvidence): string {
  const lines: string[] = [
    "任务：基于统计与采样证据，归纳这位用户的写作风格定性画像（内部工作流，不面向用户）。",
    "",
    OUTPUT_CONTRACT,
    "",
    `语料规模：${input.sketchCount} 篇文档，约 ${input.charCount} 字符。`,
    "",
    "统计摘要：",
    ...[...input.sections.vocabulary, ...input.sections.sentence, ...input.sections.structure]
      .map((line) => `- ${line}`),
    ...(input.supportedTokens.length > 0 ? [
      "高频用词（token / 总次数 / 出现篇数）：",
      ...input.supportedTokens.slice(0, 12).map((entry) => `- ${entry.token}：${entry.count} 次 / ${entry.docFrequency} 篇`),
    ] : []),
    "",
    "采样证据（多篇文档的原文摘录）：",
    ...(input.evidenceLines.length > 0
      ? input.evidenceLines.map((line) => `- ${line}`)
      : ["（无）"]),
    ...(input.behavior && (input.behavior.instructionCounts.length > 0 || input.behavior.revisionCount > 0 || input.behavior.reviewRejectedCount > 0) ? [
      "",
      "用户行为证据（用户如何要求 Agent 修改、以及亲自改 Agent 输出的方向）——这是最强信号，优先于统计：",
      ...input.behavior.instructionCounts.map((entry) => `- 修改指令「${entry.label}」出现 ${entry.count} 次`),
      ...input.behavior.instructionSamples.slice(0, 5).map((sample) => `- 指令原话：「${sample.instruction}」`),
      ...(input.behavior.revisionCount > 0 && input.behavior.averageLenDeltaRatio !== null ? [
        `- 用户 ${input.behavior.revisionCount} 次亲自修改 Agent 输出，平均长度变化 ${Math.round(input.behavior.averageLenDeltaRatio * 100)}%（负=改短）`,
        ...(input.behavior.exclamationDelta !== 0 ? [`- 感叹号净变化 ${input.behavior.exclamationDelta}`] : []),
        ...input.behavior.revisionSamples.slice(0, 2).flatMap((sample) => [
          `  - Agent 原文：${sample.before}`,
          `  - 用户改为：${sample.after}`,
        ]),
      ] : []),
      ...(input.behavior.reviewRejectedCount > 0 ? [
        `- 用户在审阅中拒绝过 ${input.behavior.reviewRejectedCount} 个 Agent 修改提案项（另接受 ${input.behavior.reviewAcceptedCount} 项）`,
        ...input.behavior.reviewSamples.slice(0, 2).map((sample) => `- 被拒绝的提案摘录：${sample}`),
      ] : []),
    ] : []),
    "",
    "请给出风格画像 JSON。",
  ];
  return lines.join("\n");
}

function coerceStringArray(value: unknown, field: string): string[] {
  // 字段缺失 = 证据不足，按空数组处理（§6 硬约束的对称语义）。
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new WritingStyleLlmError(`${field} 缺失或不是数组`);
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => (item.length <= MAX_ITEM_LENGTH ? item : item.slice(0, MAX_ITEM_LENGTH)))
    .slice(0, MAX_ARRAY_ITEMS);
}

/** 校验 + 收敛输出（宽松解析：剥围栏、定位 JSON 主体；严格 schema）。 */
export function parseQualitative(content: string): WritingStyleQualitative {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new WritingStyleLlmError("no JSON object found");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch (error) {
    throw new WritingStyleLlmError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new WritingStyleLlmError("payload is not an object");
  const root = parsed as Record<string, unknown>;
  const preferences = root.preferences;
  const preferencesRecord = typeof preferences === "object" && preferences !== null
    ? preferences as Record<string, unknown>
    : {};
  const summaryRaw = root.summary;
  const summary = typeof summaryRaw === "string" ? summaryRaw.trim().slice(0, 80) : "";
  return {
    tone: coerceStringArray(root.tone, "tone"),
    phrases: coerceStringArray(root.phrases, "phrases"),
    preferences: {
      do: coerceStringArray(preferencesRecord.do, "preferences.do"),
      dont: coerceStringArray(preferencesRecord.dont, "preferences.dont"),
    },
    summary,
  };
}

/** 协作轮洞察蒸馏的输入证据（§4.1 行为信号的一轮切片）。 */
export interface WritingStyleRoundEvidence {
  /** 指令原话（≤8 条，截断）。 */
  instructions: string[];
  /** 手改对（≤3 对，摘录已截断）。 */
  revisionSamples: Array<{ before: string; after: string }>;
  /** 手改方向：平均长度变化比（负=改短）与感叹号净变化。 */
  averageLenDeltaRatio: number | null;
  exclamationDelta: number;
  /** 审阅拒绝统计。 */
  reviewRejectedCount: number;
  reviewAcceptedCount: number;
  reviewSamples: string[];
}

const INSIGHT_CONTRACT = [
  "输出一个 JSON 对象（不要 Markdown 围栏、解释或额外字段），结构：",
  '{"preferences": string[]}',
  "preferences=从这轮协作行为归纳出的用户写作/协作偏好，2-4 条；每条一句完整的话（≤40 字），陈述稳定的偏好结论。",
  "硬约束：总结偏好而不是罗列次数、复述指令或转述样例；两条证据指向同一偏好时合并为一条；证据不足以得出任何偏好时返回空数组；全部用中文。",
].join("\n");

function buildRoundPrompt(input: WritingStyleRoundEvidence): string {
  const lines: string[] = [
    "任务：从用户与 Agent 的一轮文档协作行为（用户下的修改指令、亲手做的修改、审阅时的取舍）归纳用户的写作偏好（内部工作流，不面向用户）。",
    "",
    INSIGHT_CONTRACT,
    "",
    "本轮行为证据：",
    ...input.instructions.map((instruction) => `- 修改指令原话：「${instruction}」`),
    ...(input.revisionSamples.length > 0 ? [
      ...input.revisionSamples.flatMap((sample) => [
        `- 用户亲手把 Agent 输出的一段改为：`,
        `  - 原文：${sample.before}`,
        `  - 改为：${sample.after}`,
      ]),
    ] : []),
    ...(input.averageLenDeltaRatio !== null
      ? [`- 用户亲手修改的平均长度变化：${Math.round(input.averageLenDeltaRatio * 100)}%（负=改短）`]
      : []),
    ...(input.exclamationDelta !== 0 ? [`- 感叹号净变化：${input.exclamationDelta}`] : []),
    ...(input.reviewRejectedCount > 0 ? [
      `- 审阅取舍：拒绝了 ${input.reviewRejectedCount} 个修改提案项、接受 ${input.reviewAcceptedCount} 项`,
      ...input.reviewSamples.map((sample) => `  - 被拒绝的提案摘录：${sample}`),
    ] : []),
    "",
    "请给出偏好 JSON。",
  ];
  return lines.join("\n");
}

/** 校验 + 收敛洞察输出（宽松解析：剥围栏、定位 JSON 主体；preferences ≤4 条、每条 ≤60 字）。 */
export function parseInsight(content: string): string[] {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new WritingStyleLlmError("no JSON object found");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch (error) {
    throw new WritingStyleLlmError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new WritingStyleLlmError("payload is not an object");
  const preferences = (parsed as Record<string, unknown>).preferences;
  if (!Array.isArray(preferences)) throw new WritingStyleLlmError("preferences 缺失或不是数组");
  return preferences
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => (item.length <= 60 ? item : item.slice(0, 60)))
    .slice(0, 4);
}

/**
 * 直接调用内部 runtime（对齐 knowledge 模块 this.llm 模式，方案 §6）：
 * 不建 dispatch_only agent bundle，runtime 由 runtime-factory 构建隔离的
 * 无工具内部实例（ingest-filter 同款）。
 */
export class WritingStyleLlm {
  constructor(private readonly runtime: AgentRuntime) {}

  async summarize(input: WritingStyleEvidence): Promise<WritingStyleQualitative> {
    let lastError = "";
    // 两次尝试（第二次带解析错误反馈），失败抛 WritingStyleLlmError。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = lastError
        ? `${buildPrompt(input)}\n\n上一次输出无法解析：${lastError}\n请严格只输出合法 JSON。`
        : buildPrompt(input);
      const content = await invokeRuntime(this.runtime, prompt, {
        sessionId: `writing-style:${randomUUID()}`,
        pageLabel: "Writing style internal workflow",
        timeoutMs: CHAT_TIMEOUT_MS,
      });
      try {
        return parseQualitative(content.slice(0, MAX_RESPONSE_CHARS));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new WritingStyleLlmError(`LLM response unparsable: ${lastError}`);
  }

  /** 协作轮洞察蒸馏：把一轮行为信号归纳为偏好陈述（§4.1/用户决策：总结偏好而非计数）。 */
  async summarizeBehaviorRound(input: WritingStyleRoundEvidence): Promise<string[]> {
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = lastError
        ? `${buildRoundPrompt(input)}\n\n上一次输出无法解析：${lastError}\n请严格只输出合法 JSON。`
        : buildRoundPrompt(input);
      const content = await invokeRuntime(this.runtime, prompt, {
        sessionId: `writing-style-insight:${randomUUID()}`,
        pageLabel: "Writing style internal workflow",
        timeoutMs: CHAT_TIMEOUT_MS,
      });
      try {
        return parseInsight(content.slice(0, MAX_RESPONSE_CHARS));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new WritingStyleLlmError(`LLM response unparsable: ${lastError}`);
  }
}

