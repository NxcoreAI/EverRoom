import { describe, expect, it } from "vitest";
import { routeProxyUrlForTest } from "./open-connector-sync-executor.js";

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
      input: { messageId: "abc123", detail: "full" },
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

  it("routes notion search and block children", () => {
    expect(routeProxyUrlForTest("https://api.notion.com/v1/search", "POST", { page_size: 100, filter: { property: "object", value: "page" } }))
      .toEqual({
        service: "notion",
        action: "search",
        input: { page_size: 100, filter: { property: "object", value: "page" } },
      });

    expect(routeProxyUrlForTest("https://api.notion.com/v1/blocks/abc123/children?page_size=100", "GET"))
      .toEqual({
        service: "notion",
        action: "list_block_children",
        input: { block_id: "abc123", page_size: 100 },
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
