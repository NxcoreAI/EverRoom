import type { NormalizedAddress, NormalizedCalendarEvent, NormalizedMail } from "@nxcore/connector-contract";
import { htmlToMarkdown } from "../ingest/converters.js";

/**
 * 连接器统一格式 → 记忆文档 markdown（每封邮件/每个日程一篇，
 * 经 importToMemoryCore 入 MemoryCore，内容指纹去重幂等）。
 */

function formatAddress(address: NormalizedAddress): string {
  return address.displayName ? `${address.displayName} <${address.address}>` : address.address;
}

function formatAddresses(mail: NormalizedMail, role: string): string | null {
  const list = (mail.addresses ?? []).filter((a) => a.role === role).map(formatAddress);
  return list.length ? list.join("、") : null;
}

function mailBody(mail: NormalizedMail): string {
  if (mail.textBody?.trim()) return mail.textBody;
  if (mail.htmlBody?.trim()) {
    try {
      const markdown = htmlToMarkdown(Buffer.from(mail.htmlBody, "utf8"));
      if (markdown.trim()) return markdown;
    } catch {
      // html 无可提取文本 → 回落 snippet
    }
  }
  return mail.snippet?.trim() ?? "";
}

export function mailToMarkdown(mail: NormalizedMail): string {
  const parts: string[] = [`# ${mail.subject?.trim() || "（无主题）"}`];
  const from = formatAddresses(mail, "from");
  const to = formatAddresses(mail, "to");
  const cc = formatAddresses(mail, "cc");
  const meta = [
    from ? `发件人：${from}` : null,
    to ? `收件人：${to}` : null,
    cc ? `抄送：${cc}` : null,
    mail.receivedAt ?? mail.sentAt ? `时间：${mail.receivedAt ?? mail.sentAt}` : null,
  ].filter((line): line is string => line !== null);
  if (meta.length) parts.push(meta.join("\n\n"));
  const body = mailBody(mail);
  if (body) parts.push(body);
  return parts.join("\n\n");
}

export function calendarEventToMarkdown(event: NormalizedCalendarEvent): string {
  const parts: string[] = [`# ${event.title.trim() || "（无标题）"}`];
  const meta = [
    `时间：${event.startsAt} → ${event.endsAt}${event.timeZone ? `（${event.timeZone}）` : ""}`,
    event.location ? `地点：${event.location}` : null,
    event.organizer ? `组织者：${formatAddress(event.organizer)}` : null,
    (event.attendees ?? []).length
      ? `与会人：${event.attendees!.map(formatAddress).join("、")}`
      : null,
    event.status ? `状态：${event.status}` : null,
  ].filter((line): line is string => line !== null);
  if (meta.length) parts.push(meta.join("\n\n"));
  if (event.description?.trim()) parts.push(`## 描述\n\n${event.description.trim()}`);
  if (event.recurrence) parts.push(`## 重复规则\n\n\`\`\`json\n${JSON.stringify(event.recurrence, null, 2)}\n\`\`\``);
  return parts.join("\n\n");
}
