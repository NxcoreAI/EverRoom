import type { RoomDocument } from "@nxcore/agent-contract";
import { tiptapToMarkdown } from "./tiptap-markdown.js";

/**
 * DocEnvelope：路由器的输入契约（plan §5.1）。
 * 路由层不关心资料本体存在哪张表，只消费归一化信封——各资料实体
 * 留在自己的表里（documents / reality_events / 未来的 mail 等），
 * 新增一种资料源 = 写一个"实体 → envelope"的组装器，路由瀑布零改动。
 */
export interface DocEnvelope {
  ref: {
    kind: "everroom-doc" | "reality-event" | "mail" | "file" | "cloud-doc";
    /** 对应资料表的主键。 */
    id: string;
    /** 幂等与去重依据（documents.version / reality_events.resultVersion 等）。 */
    version: number;
  };
  title: string;
  /** 各源自负责转 markdown（everroom-doc → Tiptap 导出；reality-event → transcript+insights 组装）。 */
  markdown: string;
  /** 业务时间（会议/邮件发生时间），≠ 入库时间，⑤ 卷宗展示用。 */
  occurredAt?: string;
  /** 用户显式指定的入口归属 Room（Room 内上传文件带出）：① 层消费，
   *  Room 已删/不存在则忽略落瀑布；revert 重路由重建信封时不携带。 */
  entryRoomId?: string;
  entrySignals?: {
    sourceTag?: string;
    threadId?: string;
    filenamePrefix?: string;
    creatorId?: string;
  };
}

/** KS raw 单文件硬限制（wiki.ts:263）；超限截断正文并附标注。 */
const RAW_MAX_BYTES = 512 * 1024;
const TRUNCATION_NOTE = "\n\n> ⚠️ 本文档超出 512KB 导出上限，已截断。完整内容见 EverRoom 原文档。\n";

/** 文件名里的路径/hostile 字符清洗（文件名会进 KS sources frontmatter 与 raw/rm 溯源）。 */
function sanitizeTitleFragment(title: string): string {
  const cleaned = title
    .replace(/[\r\n\t/\\:*?"<>|#]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : "untitled";
}

/** 稳定可重入的 KS 源文件名（plan §4.3）：${sourceKind}-${sourceId}__${title-sanitized}.md */
export function envelopeFilename(envelope: DocEnvelope): string {
  return `${envelope.ref.kind}-${envelope.ref.id}__${sanitizeTitleFragment(envelope.title)}.md`;
}

/** everroom-doc → DocEnvelope（① 入口层的唯一 M0 源）。 */
export function buildDocumentEnvelope(document: RoomDocument): DocEnvelope {
  let markdown = tiptapToMarkdown(document.contentJson);
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(document.title)}`,
    `room: ${document.roomId}`,
    `version: ${String(document.version)}`,
    `updated: ${document.updatedAt}`,
    "---",
    "",
    "",
  ].join("\n");
  let content = `${frontmatter}${markdown}`;
  if (Buffer.byteLength(content, "utf8") > RAW_MAX_BYTES) {
    // 按 UTF-8 字节截断（留出标注余量），保证 raw/write 不被 413 拒绝。
    const budget = RAW_MAX_BYTES - Buffer.byteLength(TRUNCATION_NOTE, "utf8") - 64;
    content = Buffer.from(content, "utf8").subarray(0, budget).toString("utf8") + TRUNCATION_NOTE;
  }
  return {
    ref: { kind: "everroom-doc", id: document.id, version: document.version },
    title: document.title,
    markdown: content,
    occurredAt: document.updatedAt,
  };
}
