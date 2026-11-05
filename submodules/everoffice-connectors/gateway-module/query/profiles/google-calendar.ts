import type { ProfileHit, QueryProfile } from "../types.js";
import { arrayOf, asRecord, isoDate, isoTime, snippet, text } from "./shared.js";

function eventStart(event: Record<string, unknown>): string | null {
  const start = asRecord(event.start);
  return isoTime(start.dateTime) ?? (text(start.date).trim() ? `${text(start.date).trim()}T00:00:00.000Z` : null);
}

function timeBounds(ctx: { since?: string; until?: string }): Record<string, string> {
  const bounds: Record<string, string> = {};
  const since = ctx.since ? isoDate(ctx.since) : null;
  const until = ctx.until ? isoDate(ctx.until) : null;
  if (since) bounds.timeMin = `${since}T00:00:00Z`;
  if (until) bounds.timeMax = `${until}T23:59:59Z`;
  return bounds;
}

/** Google Calendar：find_event 做全文检索，get_event 读详情。 */
export const googleCalendarQueryProfile: QueryProfile = {
  service: "googlecalendar",
  dataTypes: ["event"],
  buildQueries(ctx) {
    return [
      {
        action: "find_event",
        input: {
          query: (ctx.terms.length > 0 ? ctx.terms.join(" ") : ctx.concept).trim(),
          calendarId: "primary",
          maxResults: ctx.limit,
          singleEvents: true,
          orderBy: "startTime",
          ...timeBounds(ctx),
        },
      },
    ];
  },
  parseHits(data): ProfileHit[] {
    const root = asRecord(data);
    const hits: ProfileHit[] = [];
    for (const item of arrayOf(root.events)) {
      const event = asRecord(item);
      const id = text(event.id).trim();
      if (!id) continue;
      const url = text(event.htmlLink).trim();
      hits.push({
        kind: "event",
        id,
        title: text(event.summary).trim() || "(无标题日程)",
        snippet: snippet(text(event.location) || text(event.description)),
        time: eventStart(event),
        ...(url ? { url } : {}),
      });
    }
    return hits;
  },
  buildRead(ref) {
    if (ref.kind !== "event") return null;
    return { action: "get_event", input: { eventId: ref.id, calendarId: "primary" } };
  },
  renderRead(data) {
    const event = asRecord(data);
    const title = text(event.summary).trim() || "(无标题日程)";
    const start = asRecord(event.start);
    const end = asRecord(event.end);
    const markdown = [
      `# ${title}`,
      "",
      `- Start: ${text(start.dateTime) || text(start.date) || "—"}`,
      `- End: ${text(end.dateTime) || text(end.date) || "—"}`,
      `- Location: ${text(event.location) || "—"}`,
      text(event.htmlLink) ? `- Link: ${text(event.htmlLink)}` : null,
      "",
      text(event.description).trim(),
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    return { markdown, title, ...(text(event.htmlLink) ? { url: text(event.htmlLink) } : {}) };
  },
};
