import type { ProfileHit, QueryProfile } from "../types.js";
import { arrayOf, asRecord, isoDate, isoTime, snippet, text } from "./shared.js";

function odataTerm(term: string): string {
  return term.replaceAll("'", "''");
}

function addressOf(value: unknown): string {
  const address = asRecord(asRecord(value).emailAddress);
  const name = text(address.name).trim();
  const email = text(address.address).trim();
  return [name, email].filter(Boolean).join(" ") || "—";
}

function buildFilter(ctx: { concept: string; terms: string[]; since?: string }): string | undefined {
  const terms = (ctx.terms.length > 0 ? ctx.terms : [ctx.concept]).filter(Boolean);
  const termFilter = terms.map((term) => `contains(subject,'${odataTerm(term)}')`).join(" or ");
  const since = ctx.since ? isoDate(ctx.since) : null;
  const parts = [
    since ? `receivedDateTime ge ${since}T00:00:00Z` : null,
    termFilter ? `(${termFilter})` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" and ") : undefined;
}

/** Outlook：list_messages 用 OData contains 过滤；get_message 读正文。 */
export const outlookQueryProfile: QueryProfile = {
  service: "outlook",
  dataTypes: ["mail"],
  buildQueries(ctx) {
    const filter = buildFilter(ctx);
    return [
      {
        action: "list_messages",
        input: {
          top: ctx.limit,
          orderby: "receivedDateTime desc",
          select: ["id", "subject", "from", "receivedDateTime", "bodyPreview", "webLink"],
          ...(filter ? { filter } : {}),
        },
      },
    ];
  },
  parseHits(data): ProfileHit[] {
    const root = asRecord(data);
    const hits: ProfileHit[] = [];
    for (const item of arrayOf(root.messages)) {
      const message = asRecord(item);
      const id = text(message.id).trim();
      if (!id) continue;
      const url = text(message.webLink).trim();
      hits.push({
        kind: "mail",
        id,
        title: text(message.subject).trim() || "(无主题)",
        snippet: snippet(text(message.bodyPreview) || addressOf(message.from)),
        time: isoTime(message.receivedDateTime),
        ...(url ? { url } : {}),
      });
    }
    return hits;
  },
  buildRead(ref) {
    if (ref.kind !== "mail") return null;
    return { action: "get_message", input: { messageId: ref.id, bodyContentType: "text" } };
  },
  renderRead(data) {
    const message = asRecord(data);
    const title = text(message.subject).trim() || "(无主题)";
    const body = asRecord(message.body);
    const markdown = [
      `# ${title}`,
      "",
      `- From: ${addressOf(message.from)}`,
      `- To: ${arrayOf(message.toRecipients).map(addressOf).join(", ") || "—"}`,
      `- Date: ${text(message.receivedDateTime) || "—"}`,
      text(message.webLink) ? `- Link: ${text(message.webLink)}` : null,
      "",
      text(body.content).trim() || text(message.bodyPreview).trim(),
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    return { markdown, title, ...(text(message.webLink) ? { url: text(message.webLink) } : {}) };
  },
};
