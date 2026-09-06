import { describe, expect, it } from "vitest";
import { adaptActionOutputForSyncAdapter, routeProxyUrlForTest } from "./open-connector-sync-executor.js";

describe("open-connector-sync-executor URL 路由", () => {
  it("routes gmail REST URLs to actions with translated query params", () => {
    expect(routeProxyUrlForTest("https://gmail.googleapis.com/gmail/v1/users/me/profile", "GET"))
      .toEqual({ service: "gmail", action: "get_profile", input: {} });

    expect(routeProxyUrlForTest(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=-in:spam%20-in:trash",
      "GET",
    )).toEqual({
      service: "gmail",
      action: "fetch_emails",
      input: { detail: "full", maxResults: 100, query: "-in:spam -in:trash" },
    });

    expect(routeProxyUrlForTest(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=x&pageToken=t2",
      "GET",
    )).toMatchObject({ service: "gmail", action: "fetch_emails", input: { pageToken: "t2" } });

    expect(routeProxyUrlForTest(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123?format=full",
      "GET",
    )).toEqual({
      service: "gmail",
      action: "fetch_message_by_message_id",
      // oo 的入参属性是 format（schema 禁未知字段，REST 的 detail 会被拒绝）。
      input: { messageId: "abc123", format: "full" },
    });

    expect(routeProxyUrlForTest(
      "https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=100&pageToken=p1",
      "GET",
    )).toEqual({
      service: "gmail",
      action: "list_history",
      input: { startHistoryId: "100", pageToken: "p1" },
    });
  });

  it("routes notion search and block children with oo schema input names", () => {
    expect(routeProxyUrlForTest("https://api.notion.com/v1/search", "POST", { page_size: 100, filter: { property: "object", value: "page" } }))
      .toEqual({
        service: "notion",
        action: "search",
        // oo 的 search 入参是 camelCase 且 query 必填（空串 = Notion 全量搜索）。
        input: { query: "", pageSize: 100, filter: { property: "object", value: "page" } },
      });

    expect(routeProxyUrlForTest("https://api.notion.com/v1/blocks/abc123/children?page_size=100", "GET"))
      .toEqual({
        service: "notion",
        action: "list_block_children",
        input: { blockId: "abc123", pageSize: 100 },
      });
  });

  it("routes google calendar list and prefers sync_events when syncToken present", () => {
    expect(routeProxyUrlForTest("https://www.googleapis.com/calendar/v3/users/me/calendarList", "GET"))
      .toEqual({ service: "googlecalendar", action: "list_calendars", input: {} });

    expect(routeProxyUrlForTest(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=2026-01-01T00:00:00Z&maxResults=250",
      "GET",
    )).toMatchObject({
      service: "googlecalendar",
      action: "list_events",
      input: { calendarId: "primary", timeMin: "2026-01-01T00:00:00Z", maxResults: 250 },
    });

    expect(routeProxyUrlForTest(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?syncToken=token-1",
      "GET",
    )).toMatchObject({
      service: "googlecalendar",
      action: "sync_events",
      input: { calendarId: "primary", syncToken: "token-1" },
    });
  });

  it("routes google drive files list and export", () => {
    expect(routeProxyUrlForTest(
      "https://www.googleapis.com/drive/v3/files?q=trashed%3Dfalse&pageSize=100&pageToken=t1",
      "GET",
    )).toMatchObject({
      service: "googledrive",
      action: "files.list",
      input: { q: "trashed=false", pageSize: 100, pageToken: "t1" },
    });

    expect(routeProxyUrlForTest(
      "https://www.googleapis.com/drive/v3/files/doc-1/export?mimeType=text%2Fplain",
      "GET",
    )).toEqual({
      service: "googledrive",
      action: "files.export",
      input: { fileId: "doc-1", mimeType: "text/plain" },
    });
  });

  it("routes outlook messages list and get", () => {
    expect(routeProxyUrlForTest(
      "https://graph.microsoft.com/v1.0/me/messages?$top=25&$select=id,subject",
      "GET",
    )).toMatchObject({
      service: "outlook",
      action: "list_messages",
      input: { top: 25, select: ["id", "subject"] },
    });

    expect(routeProxyUrlForTest("https://graph.microsoft.com/v1.0/me/messages/abc", "GET"))
      .toEqual({ service: "outlook", action: "get_message", input: { messageId: "abc" } });
  });

  it("returns null for unknown hosts and paths", () => {
    expect(routeProxyUrlForTest("https://example.com/api", "GET")).toBeNull();
    expect(routeProxyUrlForTest("https://gmail.googleapis.com/gmail/v1/users/me/labels", "GET")).toBeNull();
  });
});

describe("open-connector-sync-executor 输出翻译回 REST 形状", () => {
  it("maps oo normalized message back to the Gmail REST resource shape", () => {
    const adapted = adaptActionOutputForSyncAdapter("gmail", "fetch_message_by_message_id", {
      messageId: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "UNREAD"],
      subject: "安全提醒",
      sender: "no-reply@google.com",
      to: "me@gmail.com",
      preview: { subject: "安全提醒", body: "snip" },
      payload: { headers: [{ name: "Subject", value: "安全提醒" }] },
      messageText: "body",
      attachmentList: [],
      messageTimestamp: "2026-09-04T18:20:22.000Z",
    }) as Record<string, unknown>;

    expect(adapted.id).toBe("m1");
    expect(adapted.threadId).toBe("t1");
    expect(adapted.labelIds).toEqual(["INBOX", "UNREAD"]);
    expect(adapted.snippet).toBe("snip");
    // 原始 payload 无损透传，正文/附件由适配器从 payload 提取。
    expect(adapted.payload).toEqual({ headers: [{ name: "Subject", value: "安全提醒" }] });
    // ISO 时间戳还原为 REST 的毫秒 internalDate（2026-09-04T18:20:22Z）。
    expect(adapted.internalDate).toBe(String(Date.parse("2026-09-04T18:20:22.000Z")));
  });

  it("maps list item ids and passes other actions through unchanged", () => {
    const list = adaptActionOutputForSyncAdapter("gmail", "fetch_emails", {
      messages: [{ messageId: "m1", threadId: "t1" }, { messageId: "m2", threadId: "t2" }],
      nextPageToken: "n1",
      resultSizeEstimate: 2,
    }) as { messages: Array<{ id?: string; threadId?: string }>; nextPageToken: string };

    // 适配器只消费 messages[].id。
    expect(list.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(list.nextPageToken).toBe("n1");

    // list_history / 非 gmail 输出即 REST 形状，原样透传。
    const history = { history: [], historyId: "112459", nextPageToken: null };
    expect(adaptActionOutputForSyncAdapter("gmail", "list_history", history)).toBe(history);
    expect(adaptActionOutputForSyncAdapter("notion", "search", { results: [] })).toEqual({ results: [] });
  });

  it("maps oo outlook list_messages envelope back to the Graph shape", () => {
    const adapted = adaptActionOutputForSyncAdapter("outlook", "list_messages", {
      messages: [{ id: "o1", subject: "Re: Budget" }],
      nextLink: "https://graph.microsoft.com/v1.0/me/messages?$skipToken=n1",
    }) as { value: unknown[]; "@odata.nextLink"?: string };

    // 适配器消费 value/@odata.nextLink（Graph 信封）；格式映射的输入随之稳定。
    expect(adapted.value).toEqual([{ id: "o1", subject: "Re: Budget" }]);
    expect(adapted["@odata.nextLink"]).toBe("https://graph.microsoft.com/v1.0/me/messages?$skipToken=n1");
  });
});
