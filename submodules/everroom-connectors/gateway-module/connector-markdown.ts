import type {
  connectorCalendarEvents,
  connectorDocuments,
  connectorEmails,
  connectorRecords,
  connectorTodos,
} from "../../../apps/gateway/src/infrastructure/database/schema.js";
import { convertEmailBody, type EmailBodyConversion } from "./email-content.js";

type ConnectorEmail = typeof connectorEmails.$inferSelect;
type ConnectorDocument = typeof connectorDocuments.$inferSelect;
type ConnectorCalendarEvent = typeof connectorCalendarEvents.$inferSelect;
type ConnectorRecord = typeof connectorRecords.$inferSelect;
export type ConnectorTodo = typeof connectorTodos.$inferSelect;

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function yamlLine(key: string, value: unknown): string {
  return `${key}: ${JSON.stringify(value ?? null)}`;
}

function frontmatter(lines: Array<[string, unknown]>): string {
  return ["---", ...lines.map(([key, value]) => yamlLine(key, value)), "---", ""].join("\n");
}

function heading(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/^\s*#+\s*/, "").trim() || "无标题文档";
}

function person(value: { name?: string | undefined; address?: string | undefined } | null): string {
  if (!value) return "-";
  if (value.name && value.address) return `${value.name} <${value.address}>`;
  return value.name || value.address || "-";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function extensionPeople(value: unknown): string {
  if (!Array.isArray(value)) return "-";
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "-";
    const record = item as { name?: unknown; address?: unknown };
    return person({
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.address === "string" ? { address: record.address } : {}),
    });
  }).filter((item) => item !== "-").join(", ") || "-";
}

function extensionText(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mailStatus(payload: Record<string, unknown> | null): string {
  const labels: Array<[string, string, string]> = [
    ["isRead", "已读", "未读"],
    ["isStarred", "已加星标", "未加星标"],
    ["isDraft", "草稿", "非草稿"],
    ["isSpam", "垃圾邮件", "非垃圾邮件"],
    ["isTrash", "回收站中", "不在回收站"],
  ];
  return labels.flatMap(([key, yes, no]) => typeof payload?.[key] === "boolean"
    ? [payload[key] ? yes : no]
    : []).join("；") || "-";
}

function mailBody(row: ConnectorEmail): EmailBodyConversion {
  const html = extensionText(row.extensionPayload, "bodyHtml");
  return convertEmailBody({ text: row.bodyText, html });
}

export function connectorEmailToMarkdown(row: ConnectorEmail): string {
  const recipients = row.recipients.map((item) => person(item)).join(", ") || "-";
  const payload = row.extensionPayload;
  const body = mailBody(row);
  const attachments = row.extensionPayload?.attachmentList;
  const attachmentSection = Array.isArray(attachments) && attachments.length > 0
    ? `\n\n## 附件元数据\n\n\`\`\`json\n${stableJson(attachments)}\n\`\`\``
    : "";
  return `${frontmatter([
    ["ermd_version", 1],
    ["source_kind", "mail"],
    ["content_format", "markdown"],
    ["body_conversion_source", body.source],
    ["body_conversion_notes", body.notes],
    ["connector", row.service],
    ["connector_record_id", row.id],
    ["source_record_id", row.sourceRecordId],
    ["message_id", row.messageId],
    ["thread_id", row.threadId],
    ["in_reply_to", extensionText(payload, "inReplyTo")],
    ["references", Array.isArray(payload?.references) ? payload.references : []],
    ["connection_name", row.connectionName],
    ["received_at", extensionText(payload, "receivedAt")],
    ["source_url", extensionText(payload, "sourceUrl")],
    ["is_read", payload?.isRead],
    ["is_starred", payload?.isStarred],
    ["is_draft", payload?.isDraft],
    ["is_spam", payload?.isSpam],
    ["is_trash", payload?.isTrash],
    ["source_updated_at", iso(row.sourceUpdatedAt)],
  ])}# ${row.subject}\n\n## 邮件信息\n\n- 发件人：${person({ name: row.senderName ?? undefined, address: row.senderAddress ?? undefined })}\n- 收件人：${recipients}\n- 抄送：${extensionPeople(payload?.cc)}\n- 密送：${extensionPeople(payload?.bcc)}\n- 回复至：${extensionPeople(payload?.replyTo)}\n- 发送时间：${iso(row.sentAt) ?? "-"}\n- 接收时间：${extensionText(payload, "receivedAt") ?? "-"}\n- 标签：${row.labels.join(", ") || "-"}\n- 状态：${mailStatus(payload)}\n- 包含附件：${row.hasAttachments ? "是" : "否"}\n- 来源：${extensionText(payload, "sourceUrl") ?? "-"}\n\n## 正文\n\n${body.markdown || "(无正文)"}${attachmentSection}\n`;
}

export function connectorDocumentToMarkdown(row: ConnectorDocument): string {
  const body = row.bodyText.replace(/\r\n?/g, "\n").trim() || "(无正文)";
  return `${frontmatter([
    ["ermd_version", 1],
    ["source_kind", "cloud-doc"],
    ["connector", row.service],
    ["connection_name", row.connectionName],
    ["connector_record_id", row.id],
    ["source_record_id", row.sourceRecordId],
    ["document_id", row.documentId],
    ["document_type", row.documentType],
    ["content_format", "markdown"],
    ["source_url", row.sourceUrl],
    ["source_updated_at", iso(row.sourceUpdatedAt)],
    ["source_metadata", row.extensionPayload ?? {}],
  ])}# ${heading(row.title)}\n\n## 文档信息\n\n- 所有者：${row.ownerName || "-"}\n- 类型：${row.documentType || "-"}\n- 来源：${row.sourceUrl || "-"}\n- 更新时间：${iso(row.sourceUpdatedAt) ?? "-"}\n\n## 正文\n\n${body}\n`;
}

export function connectorCalendarEventToMarkdown(row: ConnectorCalendarEvent): string {
  const attendees = row.attendees.length > 0
    ? row.attendees.map((item) => `- ${person(item)}${item.status ? ` (${item.status})` : ""}`).join("\n")
    : "- 无";
  return `${frontmatter([
    ["source_kind", "calendar-event"],
    ["connector", row.service],
    ["connector_record_id", row.id],
    ["source_record_id", row.sourceRecordId],
    ["event_id", row.eventId],
    ["source_updated_at", iso(row.sourceUpdatedAt)],
  ])}# ${row.title}\n\n## 日程信息\n\n- 状态：${row.status || "-"}\n- 开始：${iso(row.startAt) ?? "-"}\n- 结束：${iso(row.endAt) ?? "-"}\n- 全天：${row.allDay ? "是" : "否"}\n- 地点：${row.location || "-"}\n- 组织者：${person(row.organizer)}\n\n## 参与者\n\n${attendees}\n\n## 描述\n\n${row.description || "(无描述)"}\n`;
}

export function connectorTodoToMarkdown(row: ConnectorTodo): string {
  const notes = row.notes.replace(/\r\n?/g, "\n").trim() || "(无备注)";
  return `${frontmatter([
    ["source_kind", "todo"],
    ["connector", row.service],
    ["connector_record_id", row.id],
    ["source_record_id", row.sourceRecordId],
    ["todo_id", row.todoId],
    ["list_id", row.listId],
    ["source_updated_at", iso(row.sourceUpdatedAt)],
  ])}# ${heading(row.title)}\n\n## 待办信息\n\n- 状态：${row.status || "-"}\n- 截止：${iso(row.dueAt) ?? "-"}\n- 完成时间：${iso(row.completedAt) ?? "-"}\n- 优先级：${row.priority || "-"}\n- 清单：${row.listName || "-"}\n\n## 备注\n\n${notes}\n`;
}

export function connectorGenericRecordToMarkdown(row: ConnectorRecord): string {
  const title = genericTitle(row);
  return `${frontmatter([
    ["source_kind", "connector-record"],
    ["connector", row.service],
    ["dataset", row.dataset],
    ["connector_record_id", row.id],
    ["source_record_id", row.sourceRecordId],
    ["source_updated_at", iso(row.sourceUpdatedAt)],
  ])}# ${title}\n\n## 来源信息\n\n- 连接器：${row.service}\n- 数据集：${row.dataset}\n- 来源记录：${row.sourceRecordId}\n- 来源更新时间：${iso(row.sourceUpdatedAt) ?? "-"}\n\n## 结构化内容\n\n\`\`\`json\n${stablePrettyJson(row.payload)}\n\`\`\`\n`;
}

function stablePrettyJson(value: unknown): string {
  return JSON.stringify(stableValue(value), null, 2) ?? "null";
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
  }
  return value;
}

function genericTitle(row: ConnectorRecord): string {
  for (const key of ["title", "name", "subject", "summary"]) {
    const value = row.payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return `${row.dataset} · ${row.sourceRecordId}`;
}
