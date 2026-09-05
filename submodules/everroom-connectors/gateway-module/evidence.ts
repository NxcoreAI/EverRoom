import type {
  connectorCalendarEvents,
  connectorDocuments,
  connectorEmails,
} from "../../../apps/gateway/src/infrastructure/database/schema.js";

export interface ConnectorEvidence {
  sourceId: string;
  sourceKind: "mail" | "cloud-doc";
  dataType: "mail" | "document" | "calendar";
  title: string;
  markdown: string;
  occurredAt: string;
}

function section(title: string, value: string | null | undefined): string | null {
  const content = value?.trim();
  return content ? `## ${title}\n\n${content}` : null;
}

function metadata(lines: Array<string | null>): string | null {
  const values = lines.filter((line): line is string => Boolean(line));
  return values.length > 0 ? values.join("\n") : null;
}

export function emailEvidence(row: typeof connectorEmails.$inferSelect): ConnectorEvidence {
  const occurredAt = row.sentAt ?? row.sourceUpdatedAt ?? row.syncedAt;
  const recipients = row.recipients
    .map((recipient) => recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address)
    .join("、");
  const meta = metadata([
    row.senderAddress ? `发件人：${row.senderName ? `${row.senderName} <${row.senderAddress}>` : row.senderAddress}` : null,
    recipients ? `收件人：${recipients}` : null,
    `时间：${occurredAt.toISOString()}`,
    row.labels.length > 0 ? `标签：${row.labels.join("、")}` : null,
  ]);
  return {
    sourceId: `connector_email:${row.id}`,
    sourceKind: "mail",
    dataType: "mail",
    title: row.subject,
    markdown: [`# ${row.subject}`, meta, section("正文", row.bodyText)].filter(Boolean).join("\n\n"),
    occurredAt: occurredAt.toISOString(),
  };
}

export function documentEvidence(row: typeof connectorDocuments.$inferSelect): ConnectorEvidence {
  const occurredAt = row.sourceUpdatedAt ?? row.syncedAt;
  const meta = metadata([
    row.ownerName ? `所有者：${row.ownerName}` : null,
    row.documentType ? `类型：${row.documentType}` : null,
    row.sourceUrl ? `来源：${row.sourceUrl}` : null,
    `更新时间：${occurredAt.toISOString()}`,
  ]);
  return {
    sourceId: `connector_document:${row.id}`,
    sourceKind: "cloud-doc",
    dataType: "document",
    title: row.title,
    markdown: [`# ${row.title}`, meta, section("正文", row.bodyText)].filter(Boolean).join("\n\n"),
    occurredAt: occurredAt.toISOString(),
  };
}

export function calendarEvidence(row: typeof connectorCalendarEvents.$inferSelect): ConnectorEvidence {
  const occurredAt = row.startAt ?? row.sourceUpdatedAt ?? row.syncedAt;
  const attendees = row.attendees
    .map((attendee) => attendee.name ?? attendee.address)
    .filter((value): value is string => Boolean(value))
    .join("、");
  const organizer = row.organizer && typeof row.organizer === "object"
    ? [row.organizer.name, row.organizer.address].filter(Boolean).join(" ")
    : "";
  const meta = metadata([
    row.startAt ? `开始：${row.startAt.toISOString()}` : null,
    row.endAt ? `结束：${row.endAt.toISOString()}` : null,
    row.location ? `地点：${row.location}` : null,
    organizer ? `组织者：${organizer}` : null,
    attendees ? `参与者：${attendees}` : null,
    row.status ? `状态：${row.status}` : null,
  ]);
  return {
    sourceId: `connector_calendar:${row.id}`,
    sourceKind: "mail",
    dataType: "calendar",
    title: row.title,
    markdown: [`# ${row.title}`, meta, section("描述", row.description)].filter(Boolean).join("\n\n"),
    occurredAt: occurredAt.toISOString(),
  };
}
