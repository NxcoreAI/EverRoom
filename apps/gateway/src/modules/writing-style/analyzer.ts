/**
 * Writing style 确定性统计层（docs/writing-style-profile-plan.zh-CN.md §5）。
 * 纯函数、无 DB：analyze() 产出 per-doc sketch，mergeSketches() 聚合，
 * deriveProfile() 应用支持度门槛并派生注入摘要。全部信号为计数或分布，
 * merge 满足交换律与结合律（增量更新的基础）。
 */

export interface WritingStyleSketchSamples {
  openingExcerpt: string;
  closingExcerpt: string;
  longestSentence: string;
  shortestSentence: string;
  /** 代表句（首句/中位句 + 各 1，截断 160）。 */
  representativeSentences: string[];
  /** top 高频 token 的首个含该 token 的原句（≤5 组）。 */
  tokenExamples: Array<[string, string]>;
}

export interface WritingStyleSketchStats {
  schemaVersion: 1;
  truncated: boolean;
  charCount: number;
  cjkCount: number;
  latinWordCount: number;
  sentences: {
    count: number;
    /** [<=15 字, 16-40 字, >40 字] */
    lengthBuckets: [number, number, number];
    question: number;
    exclamation: number;
    connectives: Record<string, number>;
  };
  punctuation: Record<string, number>;
  /** top token 快照：[token, count]，每 sketch 上限 60 条控制体积 */
  tokens: Array<[string, number]>;
  /** 采样证据（§6：LLM 定性层的输入，不参与 merge 合并）。 */
  samples: WritingStyleSketchSamples;
  structure: {
    blockCounts: Record<string, number>;
    listItemCount: number;
    /** 段落字符数分桶 [<=80, 81-200, 201-400, >400] */
    paragraphCharBuckets: [number, number, number, number];
    opening: Record<string, number>;
    closing: Record<string, number>;
  };
}

const NODE_BUDGET = 20_000;
const TEXT_CHAR_BUDGET = 2_000_000;
const TOKEN_TOP_N = 60;

const CJK_RE = /[㐀-䶿一-鿿]/;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9'-]*/g;

/** 表驱动连接词（方案 §5.2，可扩充）。 */
export const CONNECTIVES = [
  "因此", "所以", "不过", "然而", "另外", "首先", "其次", "最后",
  "总之", "综上", "但是", "而且", "并且", "同时", "其实", "基本上",
] as const;

const CJK_STOPWORD_CHARS = new Set(
  "的了是在我你他她它们那这有和与就都而及等之或一不也没很还只被把让给从到向着个些什么的如何若虽则其又更最自家等因所此",
);
const LATIN_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "be", "this", "that", "it", "as", "at", "by", "from",
  "we", "you", "they", "i", "was", "were", "will", "can", "not",
]);

const OPENING_SUMMARY_RE = /^(本文|这篇|以下是|下面|本篇|概述|总结|结论|概要|背景是)/;
const CLOSING_SUMMARY_RE = /(综上|总之|总的来说|总结一下|下一步|后续会|接下来我们|以上就是)/;

interface WalkState {
  nodeCount: number;
  charCount: number;
  text: string;
  blockCounts: Record<string, number>;
  listItemCount: number;
  paragraphCharBuckets: [number, number, number, number];
  paragraphs: Array<{ type: string; text: string }>;
  truncated: boolean;
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function normalizeBlockType(node: TiptapNode): string | null {
  switch (node.type) {
    case "heading":
      return `heading${Math.min(Math.max(node.attrs?.level ?? 2, 1), 4)}`;
    case "paragraph":
      return "paragraph";
    case "bulletList":
      return "listBullet";
    case "orderedList":
      return "listOrdered";
    case "taskList":
      return "listTask";
    case "table":
      return "table";
    case "blockquote":
      return "blockquote";
    case "codeBlock":
      return "codeBlock";
    case "image":
      return "image";
    case "documentBlockReference":
      return "blockRef";
    default:
      return null;
  }
}

interface TiptapNode {
  type?: string;
  attrs?: { level?: number; [key: string]: unknown } | null;
  text?: string;
  content?: TiptapNode[];
}

function collectText(node: TiptapNode, state: WalkState): string {
  if (node.text) return node.text;
  if (!node.content) return "";
  let out = "";
  for (const child of node.content) out += collectText(child, state);
  return out;
}

/** 递归遍历：结构计数（全部层级）+ 文本累积（预算内）。 */
function walk(node: TiptapNode, state: WalkState, depth: number): void {
  state.nodeCount += 1;
  if (state.nodeCount > NODE_BUDGET || state.charCount > TEXT_CHAR_BUDGET) {
    state.truncated = true;
    return;
  }
  if (node.type === "text" && typeof node.text === "string") {
    state.charCount += node.text.length;
    state.text += node.text;
    return;
  }
  if (depth === 1) {
    const blockType = normalizeBlockType(node);
    if (blockType) {
      bump(state.blockCounts, blockType);
      if (blockType === "paragraph" || blockType.startsWith("heading") || blockType.startsWith("list")) {
        state.paragraphs.push({ type: blockType, text: collectText(node, state) });
      }
    }
  } else {
    const blockType = normalizeBlockType(node);
    if (blockType) bump(state.blockCounts, blockType);
    if (node.type === "listItem" || node.type === "taskItem") state.listItemCount += 1;
    if (node.type === "paragraph") {
      const text = collectText(node, state);
      const length = text.length;
      const bucket = length <= 80 ? 0 : length <= 200 ? 1 : length <= 400 ? 2 : 3;
      state.paragraphCharBuckets[bucket] += 1;
    }
  }
  if (node.content) for (const child of node.content) walk(child, state, depth + 1);
}

function countPunctuation(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ch of text) {
    switch (ch) {
      case "、": bump(counts, "dun"); break;
      case "，": bump(counts, "commaFull"); break;
      case ",": bump(counts, "commaHalf"); break;
      case "；": bump(counts, "semicolonFull"); break;
      case ";": bump(counts, "semicolonHalf"); break;
      case "：": bump(counts, "colonFull"); break;
      case ":": bump(counts, "colonHalf"); break;
      case "。": bump(counts, "periodFull"); break;
      case ".": bump(counts, "periodHalf"); break;
      case "！": bump(counts, "exclamationFull"); break;
      case "!": bump(counts, "exclamationHalf"); break;
      case "？": bump(counts, "questionFull"); break;
      case "?": bump(counts, "questionHalf"); break;
      case "…": bump(counts, "ellipsis"); break;
      case "—": bump(counts, "dash"); break;
      default: break;
    }
  }
  return counts;
}

function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?；;…\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function extractTokens(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const cjkRuns: string[] = [];
  let run = "";
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      run += ch;
    } else {
      if (run) cjkRuns.push(run);
      run = "";
    }
  }
  if (run) cjkRuns.push(run);
  for (const segment of cjkRuns) {
    for (let i = 0; i + 1 < segment.length; i += 1) {
      const a = segment[i];
      const b = segment[i + 1];
      if (!a || !b) continue;
      if (CJK_STOPWORD_CHARS.has(a) || CJK_STOPWORD_CHARS.has(b)) continue;
      const token = a + b;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  for (const match of text.matchAll(LATIN_WORD_RE)) {
    const word = match[0].toLowerCase();
    if (word.length < 3 || LATIN_STOPWORDS.has(word)) continue;
    const folded = word.replace(/(ies)$/, "y").replace(/(es|ed|ing|s)$/, "");
    counts.set(folded, (counts.get(folded) ?? 0) + 1);
  }
  return counts;
}

function significantParagraphs(state: WalkState): Array<{ type: string; text: string }> {
  return state.paragraphs.filter((entry) => entry.text.trim().length > 0);
}

/** 分析单篇文档正文（body-only Tiptap JSON）。 */
export function analyzeWritingStyle(contentJson: unknown): WritingStyleSketchStats {
  const state: WalkState = {
    nodeCount: 0,
    charCount: 0,
    text: "",
    blockCounts: {},
    listItemCount: 0,
    paragraphCharBuckets: [0, 0, 0, 0],
    paragraphs: [],
    truncated: false,
  };
  const root = (contentJson ?? {}) as TiptapNode;
  const topLevel = Array.isArray(root.content) ? root.content : [];
  for (const child of topLevel) walk(child, state, 1);

  const sentences = splitSentences(state.text);
  const lengthBuckets: [number, number, number] = [0, 0, 0];
  // 问句/感叹句按原文标点计数（splitSentences 已剥掉句末分隔符）。
  let question = 0;
  let exclamation = 0;
  for (const ch of state.text) {
    if (ch === "？" || ch === "?") question += 1;
    else if (ch === "！" || ch === "!") exclamation += 1;
  }
  for (const sentence of sentences) {
    const length = sentence.length;
    lengthBuckets[length <= 15 ? 0 : length <= 40 ? 1 : 2] += 1;
  }
  const connectives: Record<string, number> = {};
  for (const word of CONNECTIVES) {
    const hits = state.text.split(word).length - 1;
    if (hits > 0) connectives[word] = hits;
  }

  const tokenCounts = extractTokens(state.text);
  const tokens = [...tokenCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOKEN_TOP_N);

  const meaningful = significantParagraphs(state);
  const opening: Record<string, number> = {};
  const closing: Record<string, number> = {};
  const first = meaningful[0];
  if (first) {
    const normalize = (type: string): string =>
      type === "heading1" || type === "heading2" || type === "heading3" || type === "heading4" ? "heading" : type;
    bump(opening, normalize(first.type));
    if (first.type === "paragraph" && OPENING_SUMMARY_RE.test(first.text)) bump(opening, "openingSummary");
    const last = meaningful[meaningful.length - 1] ?? first;
    bump(closing, normalize(last.type));
    if (last.type === "listTask") bump(closing, "closingActionItems");
    if (last.type === "paragraph" && CLOSING_SUMMARY_RE.test(last.text)) bump(closing, "closingSummary");
  }

  let cjkCount = 0;
  for (const ch of state.text) if (CJK_RE.test(ch)) cjkCount += 1;
  const latinWordCount = (state.text.match(LATIN_WORD_RE) ?? []).length;

  const clip = (value: string, max = 160): string => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);
  const sorted = [...sentences].sort((a, b) => b.length - a.length);
  const longestSentence = sorted[0] ?? "";
  const shortestSentence = sorted[sorted.length - 1] ?? "";
  const representativeSentences = [
    sentences[0],
    sentences[Math.floor(sentences.length / 2)],
    sentences[sentences.length - 1],
  ].filter((value): value is string => Boolean(value)).map((value) => clip(value));
  const tokenExamples: Array<[string, string]> = [];
  for (const [token] of tokens.slice(0, 5)) {
    const sentence = sentences.find((candidate) => candidate.includes(token));
    if (sentence) tokenExamples.push([token, clip(sentence)]);
  }
  const firstParagraph = meaningful.find((entry) => entry.type === "paragraph") ?? meaningful[0];
  const lastParagraph = [...meaningful].reverse().find((entry) => entry.type === "paragraph")
    ?? meaningful[meaningful.length - 1];
  const samples: WritingStyleSketchSamples = {
    openingExcerpt: clip(firstParagraph?.text ?? ""),
    closingExcerpt: clip(lastParagraph?.text ?? ""),
    longestSentence: clip(longestSentence),
    shortestSentence: clip(shortestSentence),
    representativeSentences,
    tokenExamples,
  };

  return {
    schemaVersion: 1,
    truncated: state.truncated,
    charCount: state.charCount,
    cjkCount,
    latinWordCount,
    sentences: { count: sentences.length, lengthBuckets, question, exclamation, connectives },
    punctuation: countPunctuation(state.text),
    tokens,
    samples,
    structure: {
      blockCounts: state.blockCounts,
      listItemCount: state.listItemCount,
      paragraphCharBuckets: state.paragraphCharBuckets,
      opening,
      closing,
    },
  };
}

// ─── 聚合与派生 ───

export interface WritingStyleAggregate {
  schemaVersion: 1;
  sketchCount: number;
  charCount: number;
  cjkCount: number;
  latinWordCount: number;
  sentenceCount: number;
  sentenceLengthBuckets: [number, number, number];
  question: number;
  exclamation: number;
  connectiveTotals: Record<string, number>;
  connectiveDocFreq: Record<string, number>;
  punctuationTotals: Record<string, number>;
  tokenTotals: Record<string, number>;
  tokenDocFreq: Record<string, number>;
  blockCounts: Record<string, number>;
  listItemCount: number;
  paragraphCharBuckets: [number, number, number, number];
  opening: Record<string, number>;
  closing: Record<string, number>;
}

export const EMPTY_AGGREGATE: WritingStyleAggregate = {
  schemaVersion: 1,
  sketchCount: 0,
  charCount: 0,
  cjkCount: 0,
  latinWordCount: 0,
  sentenceCount: 0,
  sentenceLengthBuckets: [0, 0, 0],
  question: 0,
  exclamation: 0,
  connectiveTotals: {},
  connectiveDocFreq: {},
  punctuationTotals: {},
  tokenTotals: {},
  tokenDocFreq: {},
  blockCounts: {},
  listItemCount: 0,
  paragraphCharBuckets: [0, 0, 0, 0],
  opening: {},
  closing: {},
};

/** 独立副本的空聚合（避免共享常量里的数组/对象引用被合并污染）。 */
export function freshAggregate(): WritingStyleAggregate {
  return {
    schemaVersion: 1,
    sketchCount: 0,
    charCount: 0,
    cjkCount: 0,
    latinWordCount: 0,
    sentenceCount: 0,
    sentenceLengthBuckets: [0, 0, 0],
    question: 0,
    exclamation: 0,
    connectiveTotals: {},
    connectiveDocFreq: {},
    punctuationTotals: {},
    tokenTotals: {},
    tokenDocFreq: {},
    blockCounts: {},
    listItemCount: 0,
    paragraphCharBuckets: [0, 0, 0, 0],
    opening: {},
    closing: {},
  };
}

/** 逐 sketch 合并（顺序无关）。 */
export function mergeSketchStats(aggregate: WritingStyleAggregate, sketch: WritingStyleSketchStats): WritingStyleAggregate {
  aggregate.sketchCount += 1;
  aggregate.charCount += sketch.charCount;
  aggregate.cjkCount += sketch.cjkCount;
  aggregate.latinWordCount += sketch.latinWordCount;
  aggregate.sentenceCount += sketch.sentences.count;
  for (let i = 0; i < 3; i += 1) {
    aggregate.sentenceLengthBuckets[i] = (aggregate.sentenceLengthBuckets[i] ?? 0) + (sketch.sentences.lengthBuckets[i] ?? 0);
  }
  aggregate.question += sketch.sentences.question;
  aggregate.exclamation += sketch.sentences.exclamation;
  for (const [word, count] of Object.entries(sketch.sentences.connectives)) {
    bump(aggregate.connectiveTotals, word, count);
    bump(aggregate.connectiveDocFreq, word, 1);
  }
  for (const [key, count] of Object.entries(sketch.punctuation)) {
    bump(aggregate.punctuationTotals, key, count);
  }
  for (const [token, count] of sketch.tokens) {
    bump(aggregate.tokenTotals, token, count);
    bump(aggregate.tokenDocFreq, token, 1);
  }
  for (const [key, count] of Object.entries(sketch.structure.blockCounts)) {
    bump(aggregate.blockCounts, key, count);
  }
  aggregate.listItemCount += sketch.structure.listItemCount;
  for (let i = 0; i < 4; i += 1) {
    aggregate.paragraphCharBuckets[i] = (aggregate.paragraphCharBuckets[i] ?? 0) + (sketch.structure.paragraphCharBuckets[i] ?? 0);
  }
  for (const [key, count] of Object.entries(sketch.structure.opening)) bump(aggregate.opening, key, count);
  for (const [key, count] of Object.entries(sketch.structure.closing)) bump(aggregate.closing, key, count);
  return aggregate;
}

export interface SupportedToken {
  token: string;
  count: number;
  docFrequency: number;
}

export interface WritingStyleDerivedProfile {
  aggregate: WritingStyleAggregate;
  supportedTokens: SupportedToken[];
  sections: {
    vocabulary: string[];
    sentence: string[];
    structure: string[];
  };
  confidenceTier: "empty" | "sparse" | "established" | "mature";
}

function ratio(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

function pct(part: number, total: number): number {
  return Math.round(ratio(part, total) * 100);
}

/** 支持度门槛（方案 §5.4）：≥2 篇且出现率 ≥30%。 */
export function meetsSupport(docFrequency: number, sketchCount: number): boolean {
  return docFrequency >= 2 && ratio(docFrequency, sketchCount) >= 0.3;
}

function supportedTokensOf(aggregate: WritingStyleAggregate): SupportedToken[] {
  return Object.entries(aggregate.tokenTotals)
    .map(([token, count]) => ({ token, count, docFrequency: aggregate.tokenDocFreq[token] ?? 0 }))
    .filter((entry) => meetsSupport(entry.docFrequency, aggregate.sketchCount))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token))
    .slice(0, 20);
}

export function deriveWritingStyleProfile(aggregate: WritingStyleAggregate): WritingStyleDerivedProfile {
  const n = aggregate.sketchCount;
  const confidenceTier = n === 0 ? "empty"
    : n < 3 ? "sparse"
      : n < 10 || aggregate.charCount < 20_000 ? "established"
        : "mature";

  const vocabulary: string[] = [];
  const tokens = supportedTokensOf(aggregate);
  if (tokens.length > 0) vocabulary.push(`高频用词：${tokens.slice(0, 8).map((entry) => entry.token).join("、")}`);
  const p = aggregate.punctuationTotals;
  const dunVsComma = (p.dun ?? 0) + (p.commaFull ?? 0);
  if (dunVsComma > 0 && ratio(p.dun ?? 0, dunVsComma) > 0.25) vocabulary.push("惯用顿号并列");
  const commaAll = (p.commaFull ?? 0) + (p.commaHalf ?? 0);
  if (commaAll > 0 && ratio(p.commaHalf ?? 0, commaAll) > 0.3) vocabulary.push("中英标点混用");

  const sentenceTotal = aggregate.sentenceCount;
  const sentenceLines: string[] = [];
  if (sentenceTotal > 0) {
    const [short, , long] = aggregate.sentenceLengthBuckets;
    if (ratio(short, sentenceTotal) >= 0.5) sentenceLines.push(`句长偏短（≤15 字占 ${pct(short, sentenceTotal)}%）`);
    else if (ratio(long, sentenceTotal) >= 0.4) sentenceLines.push(`句长偏长（>40 字占 ${pct(long, sentenceTotal)}%）`);
    if (aggregate.question > 0 && ratio(aggregate.question, sentenceTotal) >= 0.1) sentenceLines.push("常用设问");
    if (aggregate.exclamation > 0 && ratio(aggregate.exclamation, sentenceTotal) >= 0.1) sentenceLines.push("感叹句频繁");
  }
  const connectives = Object.entries(aggregate.connectiveTotals)
    .filter(([word]) => meetsSupport(aggregate.connectiveDocFreq[word] ?? 0, n))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (connectives.length > 0) sentenceLines.push(`常用连接词：${connectives.map(([word]) => word).join("、")}`);

  const structure: string[] = [];
  const b = aggregate.blockCounts;
  const perKilo = (count: number): number => aggregate.charCount > 0 ? Math.round((count / aggregate.charCount) * 1000) : 0;
  if ((b.listBullet ?? 0) + (b.listOrdered ?? 0) + (b.listTask ?? 0) > 0) {
    structure.push(`列表密度 ${perKilo((b.listBullet ?? 0) + (b.listOrdered ?? 0) + (b.listTask ?? 0))}/千字`);
  }
  const headings = ["heading1", "heading2", "heading3", "heading4"]
    .filter((key) => (b[key] ?? 0) > 0)
    .sort((a, c) => (b[c] ?? 0) - (b[a] ?? 0));
  if (headings.length > 0) structure.push(`标题层级惯用 ${headings.slice(0, 2).map((key) => key.replace("heading", "H")).join("/")}`);
  if (n > 0 && meetsSupport(aggregate.opening.openingSummary ?? 0, n)) structure.push("开篇总结先行");
  if (n > 0 && meetsSupport(aggregate.closing.closingSummary ?? 0, n)) structure.push("结尾总结收束");
  if (n > 0 && meetsSupport(aggregate.closing.closingActionItems ?? 0, n)) structure.push("结尾行动项收束");

  const section = (title: string, lines: string[]): string =>
    lines.length > 0 ? `${title}：${lines.join("；")}` : "";

  return {
    aggregate,
    supportedTokens: tokens,
    sections: { vocabulary, sentence: sentenceLines, structure },
    confidenceTier,
  };
}
