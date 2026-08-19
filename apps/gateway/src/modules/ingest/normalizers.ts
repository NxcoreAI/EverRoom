import type { TiptapJsonContent } from "@nxcore/agent-contract";
import { tiptapToMarkdown } from "../knowledge/tiptap-markdown.js";
import { titleOfFilename } from "../knowledge/file-convert.js";
import { dataTypeByExtension, dataTypeByJsonType, IngestError } from "./types.js";

/**
 * 归一化层（unified-ingest-plan §5）：md 直通；json 载荷按结构定
 * jsonType（tiptap / meeting-minutes / generic）后模板组装为 markdown；
 * office/html/csv 转换器见 converters.ts（U2）。纯函数、零 LLM。
 */

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).trim().toLowerCase() : "";
}

export interface NormalizedContent {
  /** 归一化识别的类型（无显式声明时用）。 */
  dataType?: string;
  title: string;
  markdown: string;
  occurredAt?: string;
}

// ───────────────────────── md 直通 ─────────────────────────

export function normalizeMarkdown(filename: string, buffer: Buffer): NormalizedContent {
  const markdown = buffer.toString("utf8");
  if (!markdown.trim()) throw new IngestError("文件内容为空", "empty_content");
  return { title: titleOfFilename(filename), markdown };
}

/**
 * 未知扩展名时的 md 嗅探（§4 兜底）：能按 UTF-8 解码且含标题/列表/段落
 * 特征的文本按 document 收；二进制/乱码拒绝。
 */
export function sniffAsMarkdown(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  const text = buffer.toString("utf8");
  const printable = text.replace(/[\r\n\t]/g, "");
  if (printable.length === 0) return false;
  // 替换符占比高说明按 UTF-8 解码出了半个字符（二进制误读）
  const replacementChars = (text.match(/�/g) ?? []).length;
  return replacementChars / printable.length < 0.01;
}

// ───────────────────────── json 载荷 ─────────────────────────

export type JsonPayloadType = "tiptap" | "meeting-minutes" | "generic";

/** jsonType 结构嗅探（§4：载荷不带显式 jsonType 时按结构特征判定）。 */
export function detectJsonType(payload: unknown): JsonPayloadType | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record.type === "doc" && Array.isArray(record.content)) return "tiptap";
  const minuteKeys = ["transcript", "decisions", "actionItems", "participants", "summary"];
  if (minuteKeys.some((key) => record[key] !== undefined)) return "meeting-minutes";
  if (typeof record.text === "string" || Array.isArray(record.sections)) return "generic";
  return null;
}

interface MeetingMinutesPayload {
  title?: unknown;
  occurredAt?: unknown;
  participants?: unknown;
  summary?: unknown;
  /** 决议/行动项接受 string[] 或对象数组（连接器契约 vs reality insights）。 */
  decisions?: unknown;
  actionItems?: unknown;
  transcript?: unknown;
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asObjects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    typeof item === "object" && item !== null);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 会议纪要 → md 模板（§5.2）：标题 → 与会人 → 摘要 → 决议 → 行动项 → 逐字稿。 */
export function meetingMinutesToMarkdown(payload: MeetingMinutesPayload, fallbackTitle: string): NormalizedContent {
  const title = textOf(payload.title) || fallbackTitle;
  const parts: string[] = [`# ${title}`];

  const participants = asStrings(payload.participants);
  if (participants.length > 0) parts.push(`**与会人**：${participants.join("、")}`);

  const summary = textOf(payload.summary);
  if (summary) parts.push(`## 摘要\n\n${summary}`);

  const decisions = [
    ...asStrings(payload.decisions),
    ...asObjects(payload.decisions).map((item) =>
      [textOf(item.title), textOf(item.detail)].filter(Boolean).join("：")),
  ];
  if (decisions.length > 0) {
    parts.push(`## 决议\n\n${decisions.map((item) => `- ${item}`).join("\n")}`);
  }

  const actionItems = [
    ...asStrings(payload.actionItems).map((item) => `- ${item}`),
    ...asObjects(payload.actionItems).map((item) => {
      const owner = textOf(item.owner);
      const task = textOf(item.task) || textOf(item.text);
      const due = textOf(item.due);
      return `- ${owner ? `${owner}：` : ""}${task}${due ? `（截止 ${due}）` : ""}`;
    }),
  ];
  if (actionItems.length > 0) parts.push(`## 行动项\n\n${actionItems.join("\n")}`);

  const transcript = asObjects(payload.transcript);
  if (transcript.length > 0) {
    const lines = transcript.map((item) => {
      const speaker = textOf(item.speaker) || "发言者";
      const at = textOf(item.at);
      const text = textOf(item.text);
      return `- **${speaker}**${at ? `（${at}）` : ""}：${text}`;
    });
    parts.push(`## 逐字稿\n\n${lines.join("\n")}`);
  }

  return {
    dataType: "meeting-minutes",
    title,
    markdown: parts.join("\n\n"),
    ...(textOf(payload.occurredAt) ? { occurredAt: textOf(payload.occurredAt) } : {}),
  };
}

/** generic json → md（§5.2）：{title?, text} 或 {title?, sections:[{heading, body}]}。 */
export function genericJsonToMarkdown(payload: unknown, fallbackTitle: string): NormalizedContent {
  if (typeof payload !== "object" || payload === null) {
    throw new IngestError("json 载荷不是对象", "convert_failed");
  }
  const record = payload as Record<string, unknown>;
  const title = textOf(record.title) || fallbackTitle;
  const parts: string[] = [`# ${title}`];

  if (typeof record.text === "string" && record.text.trim()) {
    parts.push(record.text.trim());
  }
  if (Array.isArray(record.sections)) {
    for (const section of asObjects(record.sections)) {
      const heading = textOf(section.heading);
      if (heading) parts.push(`## ${heading}`);
      const body = textOf(section.body);
      if (body) parts.push(body);
    }
  }
  if (parts.length === 1) throw new IngestError("json 载荷无 text/sections 内容", "convert_failed");
  return { dataType: "generic", title, markdown: parts.join("\n\n") };
}

/**
 * json 载荷归一化：显式 jsonType > 结构嗅探。返回归一化产物；
 * 识别出的注册表类型（meeting-minutes）随行返回供 classify 消费。
 */
export function normalizeJsonPayload(
  payload: unknown,
  explicitJsonType: string | undefined,
  fallbackTitle: string,
): NormalizedContent & { jsonType: JsonPayloadType } {
  const jsonType = (explicitJsonType as JsonPayloadType | undefined) ?? detectJsonType(payload);
  if (!jsonType) {
    throw new IngestError("无法识别 json 载荷结构（缺 jsonType 且结构特征不匹配）", "convert_failed");
  }
  switch (jsonType) {
    case "tiptap": {
      if (typeof payload !== "object" || payload === null) {
        throw new IngestError("tiptap 载荷不是对象", "convert_failed");
      }
      return {
        jsonType,
        title: fallbackTitle,
        markdown: tiptapToMarkdown(payload as TiptapJsonContent),
      };
    }
    case "meeting-minutes":
      return { jsonType, ...meetingMinutesToMarkdown(payload as MeetingMinutesPayload, fallbackTitle) };
    case "generic":
      return { jsonType, ...genericJsonToMarkdown(payload, fallbackTitle) };
  }
}

/** jsonType → 注册表类型（§4：meeting-minutes 有注册行；tiptap/generic 归 document）。 */
export function dataTypeOfJsonType(jsonType: string): string | null {
  return dataTypeByJsonType(jsonType)?.key ?? null;
}

/** 扩展名 → 注册表类型。 */
export function dataTypeOfExtension(extension: string): string | null {
  return dataTypeByExtension(extension)?.key ?? null;
}

/** 按字节上限安全截断（UTF-8 多字节字符不劈半）；消费端截断用（§7）。 */
export function truncateUtf8(text: string, maxBytes: number, marker: string): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // 二分找最大字符数：上界 maxBytes（ASCII 极限）
  let low = 0;
  let high = Math.min(text.length, maxBytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}\n\n${marker}`;
}
