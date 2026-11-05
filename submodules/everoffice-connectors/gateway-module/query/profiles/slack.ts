import type { ProfileHit, QueryProfile } from "../types.js";
import { arrayOf, asRecord, isoTime, snippet, text } from "./shared.js";

function slackTs(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

/** Slack：search_messages 做全文检索；get_thread 读讨论串。 */
export const slackQueryProfile: QueryProfile = {
  service: "slack",
  dataTypes: ["message"],
  buildQueries(ctx) {
    return [
      {
        action: "search_messages",
        input: {
          query: (ctx.terms.length > 0 ? ctx.terms.join(" ") : ctx.concept).trim(),
          count: ctx.limit,
          sort: "timestamp",
          sortDir: "desc",
        },
      },
    ];
  },
  parseHits(data): ProfileHit[] {
    const root = asRecord(data);
    const hits: ProfileHit[] = [];
    for (const item of arrayOf(root.matches)) {
      const match = asRecord(item);
      const channelId = text(match.channelId).trim();
      const ts = text(match.ts).trim();
      if (!channelId || !ts) continue;
      const channel = text(match.channelName).trim();
      const url = text(match.permalink).trim();
      hits.push({
        kind: "message",
        id: `${channelId}:${ts}`,
        title: channel ? `#${channel}` : "Slack message",
        snippet: snippet(text(match.text) || text(match.username)),
        time: slackTs(ts),
        ...(url ? { url } : {}),
      });
    }
    return hits;
  },
  buildRead(ref) {
    if (ref.kind !== "message") return null;
    const separator = ref.id.indexOf(":");
    if (separator <= 0) return null;
    return {
      action: "get_thread",
      input: { channelId: ref.id.slice(0, separator), threadTs: ref.id.slice(separator + 1) },
    };
  },
  renderRead(data) {
    const root = asRecord(data);
    const messages = arrayOf(root.messages);
    if (messages.length === 0) return null;
    const lines = ["# Slack thread", ""];
    for (const item of messages) {
      const message = asRecord(item);
      lines.push(`**${text(message.userId) || "unknown"}** · ${slackTs(message.ts) ?? ""}`);
      lines.push(text(message.text).trim());
      lines.push("");
    }
    return { markdown: lines.join("\n").trim() };
  },
};
