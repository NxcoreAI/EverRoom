import type { ProfileHit, QueryContext, QueryProfile } from "../types.js";
import { arrayOf, asRecord, isoDate, isoTime, snippet, text } from "./shared.js";

/** Gmail 网页链接（账号索引未知，用 all 别名，点击后由 Gmail 自行切换）。 */
const GMAIL_WEB = "https://mail.google.com/mail/u/0/#all/";

function gmailTimeFilter(ctx: QueryContext): string {
  const since = ctx.since?.trim();
  if (!since) return "";
  const date = isoDate(since);
  if (date) return ` after:${date.replaceAll("-", "/")}`;
  if (/^\d+[dwm]$/.test(since)) return ` newer_than:${since}`;
  return "";
}

function gmailQuery(ctx: QueryContext): string {
  const base = ctx.terms.length > 0 ? ctx.terms.join(" OR ") : ctx.concept;
  return `${base}${gmailTimeFilter(ctx)}`.trim();
}

/**
 * Gmail：用 fetch_emails 的 summary 档（比 search_threads 多标题/发件人/时间）。
 * 详情读 get_message（oo 已归一成 subject/from/to/date/body）。
 */
export const gmailQueryProfile: QueryProfile = {
  service: "gmail",
  dataTypes: ["mail"],
  buildQueries(ctx) {
    return [
      {
        action: "fetch_emails",
        input: {
          query: gmailQuery(ctx),
          detail: "summary",
          maxResults: ctx.limit,
          includeSpamTrash: false,
        },
      },
    ];
  },
  parseHits(data): ProfileHit[] {
    const root = asRecord(data);
    const hits: ProfileHit[] = [];
    for (const item of arrayOf(root.messages)) {
      const message = asRecord(item);
      const id = text(message.messageId).trim();
      if (!id) continue;
      const subject = text(message.subject).trim();
      const threadId = text(message.threadId).trim();
      const hit: ProfileHit = {
        kind: "mail",
        id,
        title: subject || "(无主题)",
        snippet: snippet(text(message.snippet) || text(message.sender)),
        time: isoTime(message.messageTimestamp),
        ...(threadId ? { url: `${GMAIL_WEB}${encodeURIComponent(threadId)}` } : {}),
      };
      hits.push(hit);
    }
    return hits;
  },
  buildRead(ref) {
    if (ref.kind !== "mail") return null;
    return { action: "get_message", input: { messageId: ref.id } };
  },
  renderRead(data) {
    const record = asRecord(data);
    const subject = text(record.subject).trim() || "(无主题)";
    const markdown = [
      `# ${subject}`,
      "",
      `- From: ${text(record.from).trim() || "—"}`,
      `- To: ${text(record.to).trim() || "—"}`,
      `- Date: ${text(record.date).trim() || "—"}`,
      "",
      text(record.body).trim(),
    ]
      .join("\n")
      .trim();
    return { markdown, title: subject };
  },
};
