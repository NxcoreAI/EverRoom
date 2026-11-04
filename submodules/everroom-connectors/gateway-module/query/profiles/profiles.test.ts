import { describe, expect, it } from "vitest";
import { googleDriveQueryProfile } from "./google-drive.js";
import { googleCalendarQueryProfile } from "./google-calendar.js";
import { outlookQueryProfile } from "./outlook.js";
import { slackQueryProfile } from "./slack.js";

const ctx = { concept: "预算", terms: ["预算", "budget"], limit: 20 } as const;

describe("provider query profiles", () => {
  it("maps Drive files.list results and exports details", () => {
    const queries = googleDriveQueryProfile.buildQueries(ctx);
    expect(queries[0]?.action).toBe("files.list");
    expect(queries[0]?.input.q).toContain("fullText contains '预算'");
    const hits = googleDriveQueryProfile.parseHits({
      files: [{ id: "f1", name: "预算表", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-10-01T00:00:00Z", webViewLink: "https://drive.example/f1" }],
    }, ctx);
    expect(hits[0]).toMatchObject({ kind: "document", id: "f1", title: "预算表", url: "https://drive.example/f1" });
    expect(googleDriveQueryProfile.buildRead({ kind: "document", id: "f1" })).toMatchObject({
      action: "files.export",
      input: { fileId: "f1" },
    });
  });

  it("maps Calendar find_event results and reads get_event", () => {
    const queries = googleCalendarQueryProfile.buildQueries({ ...ctx, since: "2026-09-01" });
    expect(queries[0]?.action).toBe("find_event");
    expect(queries[0]?.input.timeMin).toBe("2026-09-01T00:00:00Z");
    const hits = googleCalendarQueryProfile.parseHits({
      events: [{ id: "e1", summary: "预算评审", start: { dateTime: "2026-10-02T09:00:00Z" }, htmlLink: "https://cal.example/e1" }],
    }, ctx);
    expect(hits[0]).toMatchObject({ kind: "event", id: "e1", title: "预算评审" });
    expect(googleCalendarQueryProfile.buildRead({ kind: "event", id: "e1" })).toMatchObject({
      action: "get_event",
      input: { eventId: "e1" },
    });
  });

  it("builds an OData filter for Outlook and maps messages", () => {
    const queries = outlookQueryProfile.buildQueries({ ...ctx, since: "2026-09-01" });
    expect(queries[0]?.action).toBe("list_messages");
    expect(String(queries[0]?.input.filter)).toContain("receivedDateTime ge 2026-09-01T00:00:00Z");
    const hits = outlookQueryProfile.parseHits({
      messages: [{ id: "m1", subject: "预算确认", from: { emailAddress: { name: "CFO", address: "cfo@example.com" } }, receivedDateTime: "2026-10-03T08:00:00Z", bodyPreview: "同意" }],
    }, ctx);
    expect(hits[0]).toMatchObject({ kind: "mail", id: "m1", title: "预算确认" });
  });

  it("maps Slack search matches and reads a thread", () => {
    const hits = slackQueryProfile.parseHits({
      matches: [{ channelId: "C1", channelName: "finance", ts: "1790000000.000100", text: "预算已确认", permalink: "https://slack.example/1" }],
    }, ctx);
    expect(hits[0]).toMatchObject({ kind: "message", id: "C1:1790000000.000100", title: "#finance" });
    expect(slackQueryProfile.buildRead({ kind: "message", id: "C1:1790000000.000100" })).toMatchObject({
      action: "get_thread",
      input: { channelId: "C1", threadTs: "1790000000.000100" },
    });
  });
});
