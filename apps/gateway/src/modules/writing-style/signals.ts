/**
 * 行为信号（方案 §4 扩展）：从"用户怎么让 agent 写/改"与"用户怎么手改 agent 输出"
 * 提炼风格偏好——比静态文档更强的显式/隐式信号。本文件为纯函数：
 * 指令归类表驱动；revision delta 做方向性轻统计。
 */

/** 指令意图归类（表驱动，可扩充；未命中返回 null 仍作 LLM 证据采样）。 */
export const INSTRUCTION_CATEGORIES: Array<{ id: string; label: string; patterns: RegExp[] }> = [
  {
    id: "concise",
    label: "更简洁",
    patterns: [/简洁/, /精简/, /简短/, /啰嗦/, /冗长/, /压缩/, /删掉.*(废话|冗)/, /短(一点|些)/, /简练/, /再短/],
  },
  {
    id: "detail",
    label: "更详细",
    patterns: [/详细/, /展开/, /补充/, /具体(一点|些)/, /例子/, /示例/, /多写(一点|些)/, /丰富/],
  },
  {
    id: "formal",
    label: "更正式",
    patterns: [/正式/, /书面/, /严谨/, /商务/, /官方/, /专业(一点|些|语气)/, /庄重/],
  },
  {
    id: "casual",
    label: "更口语",
    patterns: [/口语/, /轻松/, /自然(一点|些)/, /随意/, /接地气/, /大白话/, /亲和/],
  },
  {
    id: "structured",
    label: "更结构化",
    patterns: [/分点/, /列表/, /条理/, /小标题/, /结构化/, /bullet/, /要点式/, /编号/],
  },
  {
    id: "paragraph",
    label: "改回段落",
    patterns: [/改成段落/, /不要列表/, /连成段/, /整段/],
  },
  {
    id: "tone_soft",
    label: "语气委婉",
    patterns: [/委婉/, /客气/, /温和/, /礼貌/, /柔软/, /商量的/],
  },
  {
    id: "tone_direct",
    label: "语气直接",
    patterns: [/直接/, /果断/, /有力/, /干脆/, /肯定(一点|些)/, /不要含糊/],
  },
  {
    id: "punctuation",
    label: "标点习惯",
    patterns: [/感叹号/, /少用.{0,4}!|！/, /问号/, /标点/, /顿号/, /省略号/],
  },
];

export function classifyInstruction(instruction: string): string | null {
  for (const category of INSTRUCTION_CATEGORIES) {
    if (category.patterns.some((pattern) => pattern.test(instruction))) return category.id;
  }
  return null;
}

export function instructionCategoryLabel(id: string | null): string | null {
  if (!id) return null;
  return INSTRUCTION_CATEGORIES.find((category) => category.id === id)?.label ?? null;
}

// ─── revision delta：方向性轻统计 ───

interface TiptapLikeNode {
  type?: string;
  text?: string;
  content?: TiptapLikeNode[];
}

/** 提取纯文本（预算内）。 */
export function plainTextOf(contentJson: unknown, budget = 20_000): string {
  let out = "";
  const walk = (node: TiptapLikeNode): void => {
    if (out.length >= budget) return;
    if (typeof node.text === "string") {
      out += node.text;
      return;
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk((contentJson ?? {}) as TiptapLikeNode);
  return out.slice(0, budget);
}

function sentenceLengths(text: string): number[] {
  return text
    .split(/[。！？!?；;…\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.length);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export interface RevisionDeltaMeta {
  lenBefore: number;
  lenAfter: number;
  sentenceLenBefore: number;
  sentenceLenAfter: number;
  /** 负 = 用户删了感叹号。 */
  exclamationDelta: number;
  paragraphDelta: number;
}

/** before = agent 版本文本，after = 用户手改后文本。正值 = 用户改得更多/更长。 */
export function computeRevisionDelta(beforeText: string, afterText: string): RevisionDeltaMeta {
  const beforeSentences = sentenceLengths(beforeText);
  const afterSentences = sentenceLengths(afterText);
  const countExclamation = (text: string): number => (text.match(/[！!]/g) ?? []).length;
  const countParagraphs = (text: string): number => text.split(/\n+/).filter((part) => part.trim().length > 0).length;
  return {
    lenBefore: beforeText.length,
    lenAfter: afterText.length,
    sentenceLenBefore: median(beforeSentences),
    sentenceLenAfter: median(afterSentences),
    exclamationDelta: countExclamation(afterText) - countExclamation(beforeText),
    paragraphDelta: countParagraphs(afterText) - countParagraphs(beforeText),
  };
}

export function clipSignal(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
