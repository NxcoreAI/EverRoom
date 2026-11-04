/**
 * Pi 会话的上下文预算工具（纯函数）。
 *
 * 背景：子 Agent 的一次 invocation = 一条 prompt/一个 run。pi 的自动压缩只在
 * run 结束后的下一个 prompt 前触发，run 内的工具循环不会压缩；单条超大工具结果
 * （整篇文档、Room 全量材料）或模型自己的大参数（每页 PageSpec）会随轮次反复
 * 重发，直接把 128k 窗口顶穿。这里提供两道确定性防线：
 *
 * - clampToolResultText：单条工具结果进入上下文前的字符预算（JSON 感知，
 *   优先缩短长字符串，尽量保持结构可读）。
 * - pruneToolHistory：轮次级历史裁剪——上下文用量超过阈值后，把最近 N 轮
 *   之外的 toolResult 正文与 assistant 工具参数替换成占位符，消息顺序/ID 不变。
 *
 * 两者都只影响「发给模型的那份上下文」；会话落盘与事件流仍是完整历史。
 *
 * 阈值口径：优先用 provider 返回的真实 usage（pi session.getContextUsage）；
 * 拿不到时退回 estimateContextTokens。早期版本用 chars/4 单一口径，实测中文
 * 文档 + JSON 内容会把用量低估一半左右（2026-10-23 planner 实测 113k 真实 token
 * 只估到 52.7k），导致 64k 阈值永不触发、最后靠 pi overflow 压缩兜底。
 */

export interface RunContextGuardOptions {
  /** 真实上下文 token 数（provider usage）超过该值才裁剪。 */
  triggerTokens: number;
  /** 最近 N 个带工具调用的 assistant 轮保持原样。 */
  keepRecentTurns: number;
}

interface ContentBlockLike {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
}

const TRUNCATED_NOTE = "〔结果过大，已按上下文预算截断；如需完整内容请缩小范围或分段读取。〕";

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== "\"") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** 递归缩短 JSON 中的长字符串；数组/对象结构保持。 */
function shrinkJsonStrings(value: unknown, perStringLimit: number): unknown {
  if (typeof value === "string") {
    return value.length > perStringLimit
      ? `${value.slice(0, perStringLimit)}…〔截断，原 ${value.length} 字符〕`
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => shrinkJsonStrings(item, perStringLimit));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, shrinkJsonStrings(child, perStringLimit)]),
    );
  }
  return value;
}

/**
 * 单条工具结果的字符预算。超限时：
 * - 合法 JSON：先把超长字符串字段截短再序列化；仍超限则退化为截断预览对象；
 * - 普通文本：保留前缀 + 明确截断提示。
 */
export function clampToolResultText(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  const parsed = tryParseJson(text);
  if (parsed !== undefined) {
    const perStringLimit = Math.max(512, Math.floor(maxChars / 4));
    const shrunk = JSON.stringify(shrinkJsonStrings(parsed, perStringLimit));
    if (shrunk.length <= maxChars) return shrunk;
    return JSON.stringify({
      truncated: true,
      note: `工具结果原始 ${text.length} 字符，超过上下文预算 ${maxChars}；以下为截断预览。${TRUNCATED_NOTE}`,
      preview: shrunk.slice(0, Math.max(0, Math.floor(maxChars * 0.8))),
    });
  }
  const keep = Math.max(0, maxChars - TRUNCATED_NOTE.length);
  return `${text.slice(0, keep)}${TRUNCATED_NOTE}`;
}

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content as ContentBlockLike[]) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") chars += block.text.length;
    if (typeof block.thinking === "string") chars += block.thinking.length;
    if (block.type === "toolCall" && block.arguments !== undefined) {
      try {
        chars += JSON.stringify(block.arguments).length;
      } catch {
        // 忽略不可序列化参数
      }
    }
    // 图片按 pi 的估算口径取固定字符数。
    if (block.type === "image") chars += 4_800;
  }
  return chars;
}

/** 粗估上下文字符数（chars/4 即 token 估算口径，与 pi 的 estimateTokens 同源）。 */
export function estimateContextChars(messages: readonly unknown[]): number {
  let chars = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    chars += contentChars((message as MessageLike).content);
  }
  return chars;
}

/** ASCII 每 token 字符数（与 pi 的 chars/4 口径一致）。 */
const ASCII_CHARS_PER_TOKEN = 4;
/** 非 ASCII（中文/全角标点）每字符 token 数：实测中文 tokenizer 约 0.5~0.6。 */
const CJK_TOKENS_PER_CHAR = 0.6;

/** 单段文本的保守 token 估算：ASCII 走 chars/4，CJK 按字计。 */
function textTokens(text: string): number {
  let ascii = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 128) ascii += 1;
  }
  return ascii / ASCII_CHARS_PER_TOKEN + (text.length - ascii) * CJK_TOKENS_PER_CHAR;
}

function contentTokens(content: unknown): number {
  if (typeof content === "string") return textTokens(content);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const block of content as ContentBlockLike[]) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") tokens += textTokens(block.text);
    if (typeof block.thinking === "string") tokens += textTokens(block.thinking);
    if (block.type === "toolCall" && block.arguments !== undefined) {
      try {
        tokens += textTokens(JSON.stringify(block.arguments));
      } catch {
        // 忽略不可序列化参数
      }
    }
    // 图片按 pi 的估算口径取固定字符数。
    if (block.type === "image") tokens += 4_800 / ASCII_CHARS_PER_TOKEN;
  }
  return tokens;
}

/**
 * provider usage 缺失时的兜底 token 估算：比 estimateContextChars/4 更贴近
 * 中文 + JSON 的真实用量，避免守卫在中文内容上永不触发。
 */
export function estimateContextTokens(messages: readonly unknown[]): number {
  let tokens = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    tokens += contentTokens((message as MessageLike).content);
  }
  return Math.ceil(tokens);
}

function hasToolCall(message: MessageLike | undefined): boolean {
  return Boolean(
    message
    && message.role === "assistant"
    && Array.isArray(message.content)
    && (message.content as ContentBlockLike[]).some((block) => block?.type === "toolCall"),
  );
}

function pruneMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const value = message as MessageLike;
  if (value.role === "toolResult") {
    const original = contentChars(value.content);
    const toolName = typeof value.toolName === "string" ? value.toolName : "工具";
    return {
      ...value,
      content: [{
        type: "text",
        text: `〔较早的 ${toolName} 结果已省略（原 ${original} 字符）：为控制上下文只保留最近若干轮原文；需要时重新调用工具获取。〕`,
      }],
    };
  }
  if (value.role === "assistant" && Array.isArray(value.content)) {
    let changed = false;
    const content = (value.content as ContentBlockLike[]).map((block) => {
      if (block?.type !== "toolCall") return block;
      changed = true;
      return { ...block, arguments: {} };
    });
    return changed ? { ...value, content } : message;
  }
  return message;
}

/**
 * 轮次级工具历史裁剪：保留最近 keepRecentTurns 个工具轮（assistant 工具调用 +
 * 其结果）原文，更早的 toolResult 正文替换为占位符、assistant 工具参数清空。
 * 消息数量、顺序、toolCallId 均不变，避免破坏 tool 调用配对。
 */
export function pruneToolHistory(
  messages: readonly unknown[],
  options: RunContextGuardOptions,
): unknown[] {
  const keepRecentTurns = Math.max(1, Math.floor(options.keepRecentTurns));
  const toolTurnIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (hasToolCall(message as MessageLike)) toolTurnIndexes.push(index);
  });
  if (toolTurnIndexes.length <= keepRecentTurns) return messages as unknown[];
  const cutoff = toolTurnIndexes[toolTurnIndexes.length - keepRecentTurns]!;
  let changed = false;
  const pruned = messages.map((message, index) => {
    if (index >= cutoff) return message;
    const next = pruneMessage(message);
    if (next !== message) changed = true;
    return next;
  });
  return changed ? pruned : (messages as unknown[]);
}

/**
 * 上下文超过 triggerTokens 才裁剪；未超阈值时返回原数组（不制造无谓副本）。
 * usageTokens 为 provider 返回的真实上下文 token 数（pi session.getContextUsage）；
 * 为 null/undefined 时退回 estimateContextTokens。
 */
export function guardRunMessages(
  messages: readonly unknown[],
  options: RunContextGuardOptions,
  usageTokens?: number | null,
): readonly unknown[] {
  const triggerTokens = Math.max(1, options.triggerTokens);
  const tokens = typeof usageTokens === "number" && Number.isFinite(usageTokens) && usageTokens > 0
    ? usageTokens
    : estimateContextTokens(messages);
  if (tokens <= triggerTokens) return messages;
  return pruneToolHistory(messages, options);
}
