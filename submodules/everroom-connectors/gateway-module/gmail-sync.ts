export type GmailSyncMode = "bootstrap" | "incremental" | "snapshot";

export interface GmailHistoryDelta {
  changedMessageIds: string[];
  deletedMessageIds: string[];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function gmailSyncMode(input: Record<string, unknown>): GmailSyncMode {
  const mode = textValue(input.everroomSyncMode);
  return mode === "bootstrap" || mode === "incremental" ? mode : "snapshot";
}

export function inferGmailQuery(
  name: string,
  goal: string,
  input: Record<string, unknown>,
): string | null {
  const explicit = textValue(input.query);
  if (explicit) return explicit;
  const description = `${name} ${goal}`;
  if (/(?:一|1)\s*周|(?:最近|过去|近)\s*7\s*天/u.test(description)) return "newer_than:7d";
  if (/(?:一|1)\s*个月|(?:最近|过去|近)\s*30\s*天/u.test(description)) return "newer_than:30d";
  const days = /(?:最近|过去|近)\s*(\d{1,3})\s*天/u.exec(description)?.[1];
  return days ? `newer_than:${days}d` : null;
}

function address(value: string): { name?: string; address: string } | null {
  const bracketed = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(value.trim());
  if (bracketed) {
    const name = bracketed[1]!.trim().replace(/^['"]|['"]$/g, "");
    return { ...(name ? { name } : {}), address: bracketed[2]!.trim() };
  }
  const email = /[^\s,;<>]+@[^\s,;<>]+/.exec(value)?.[0];
  return email ? { address: email } : null;
}

function addresses(value: unknown): Array<{ name?: string; address: string }> {
  if (typeof value !== "string") return [];
  const matches = [...value.matchAll(/(?:"[^"]*"|[^,;])*<[^<>\s]+@[^<>\s]+>|[^\s,;<>]+@[^\s,;<>]+/g)];
  return matches.flatMap((match) => {
    const parsed = address(match[0]);
    return parsed ? [parsed] : [];
  });
}

export function gmailMessageToDomainRecord(value: unknown): Record<string, unknown> {
  const message = objectValue(value);
  const messageId = textValue(message.messageId) ?? textValue(message.id);
  if (!messageId) throw new Error("Gmail message is missing messageId");
  const sender = typeof message.sender === "string" ? address(message.sender) : null;
  const timestamp = textValue(message.messageTimestamp) ?? textValue(message.internalDate);
  const labels = Array.isArray(message.labelIds)
    ? message.labelIds.filter((item): item is string => typeof item === "string")
    : [];
  const attachments = Array.isArray(message.attachmentList) ? message.attachmentList : [];
  const bodyHtml = textValue(message.messageHtml) ?? textValue(message.bodyHtml) ?? textValue(message.htmlBody);
  const receivedAt = textValue(message.receivedAt) ?? textValue(message.internalDate);
  const references = Array.isArray(message.references)
    ? message.references.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : textValue(message.references)?.split(/\s+/).filter(Boolean) ?? [];
  return {
    sourceRecordId: messageId,
    messageId,
    threadId: textValue(message.threadId),
    senderName: sender?.name ?? null,
    senderAddress: sender?.address ?? null,
    recipients: addresses(message.to),
    subject: typeof message.subject === "string" && message.subject.trim()
      ? message.subject.trim()
      : "(无主题)",
    sentAt: timestamp,
    bodyText: typeof message.messageText === "string"
      ? message.messageText
      : typeof objectValue(message.preview).body === "string"
        ? String(objectValue(message.preview).body)
        : "",
    labels,
    hasAttachments: attachments.length > 0,
    sourceUpdatedAt: timestamp,
    extensionPayload: {
      attachmentList: attachments,
      preview: objectValue(message.preview),
      cc: addresses(message.cc),
      bcc: addresses(message.bcc),
      replyTo: addresses(message.replyTo),
      inReplyTo: textValue(message.inReplyTo),
      references,
      receivedAt,
      bodyHtml,
      sourceUrl: textValue(message.sourceUrl) ?? textValue(message.webUrl),
      isRead: booleanValue(message.isRead) ?? (labels.length > 0 ? !labels.includes("UNREAD") : null),
      isStarred: booleanValue(message.isStarred) ?? labels.includes("STARRED"),
      isDraft: booleanValue(message.isDraft) ?? labels.includes("DRAFT"),
      isSpam: booleanValue(message.isSpam) ?? labels.includes("SPAM"),
      isTrash: booleanValue(message.isTrash) ?? labels.includes("TRASH"),
    },
  };
}

function historyMessageId(value: unknown): string | null {
  const item = objectValue(value);
  const message = objectValue(item.message);
  return textValue(message.id) ?? textValue(message.messageId) ?? textValue(item.id) ?? textValue(item.messageId);
}

export function gmailHistoryDelta(value: unknown): GmailHistoryDelta {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const entries = Array.isArray(value) ? value : [];
  for (const rawEntry of entries) {
    const entry = objectValue(rawEntry);
    for (const key of ["messages", "messagesAdded", "labelsAdded", "labelsRemoved"]) {
      const items = Array.isArray(entry[key]) ? entry[key] as unknown[] : [];
      for (const item of items) {
        const id = historyMessageId(item);
        if (!id) continue;
        changed.add(id);
        deleted.delete(id);
      }
    }
    const removed = Array.isArray(entry.messagesDeleted) ? entry.messagesDeleted as unknown[] : [];
    for (const item of removed) {
      const id = historyMessageId(item);
      if (!id) continue;
      deleted.add(id);
      changed.delete(id);
    }
  }
  return { changedMessageIds: [...changed], deletedMessageIds: [...deleted] };
}

export function connectorResultData(value: unknown): Record<string, unknown> {
  const root = objectValue(value);
  return Object.keys(objectValue(root.data)).length > 0 ? objectValue(root.data) : root;
}
