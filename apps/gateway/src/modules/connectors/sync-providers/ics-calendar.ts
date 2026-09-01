import type { SyncProviderDefinition } from "./types.js";
import { parseIcsCalendar } from "../ics.js";

/**
 * WebCal/ICS 订阅日历（阶段三首试点）：非 OAuth 源——授权通道 webcal-url
 * （用户贴 URL 即连），拉取走 direct 引擎（不经过 Nango），产出
 * NormalizedCalendarEvent 复用既有日历管线（域投影 / 路由瀑布 / Room 日程面板）。
 *
 * 增量：无 syncToken，用 ETag / Last-Modified 缓存协商——304 = 无变化直接收尾；
 * 200 = 全量重解析（唯一键 upsert 幂等）。terminalCursor 形如
 * "etag:<v>" / "lm:<v>" / "none"，作为下次 If-None-Match / If-Modified-Since。
 */
export const icsCalendarSyncProvider: SyncProviderDefinition = {
  provider: "ics-calendar",
  engine: "direct",
  dataTypes: ["calendar"],
  auth: { channel: "webcal-url" },
  defaultScopes: [{ providerScopeId: "calendar", displayName: "订阅日历" }],
  ui: { label: "日历订阅（WebCal/ICS）", category: "calendar", iconKey: "ics-calendar" },
  async *pullDirect(ctx) {
    const url = ctx.credentials;
    const headers: Record<string, string> = { Accept: "text/calendar, text/plain, */*" };
    if (ctx.sourceCursor) {
      const [kind, ...rest] = ctx.sourceCursor.split(":");
      const value = rest.join(":");
      if (kind === "etag" && value) headers["If-None-Match"] = value;
      else if (kind === "lm" && value) headers["If-Modified-Since"] = value;
    }
    const response = await ctx.httpGet(url, headers);
    if (response.status === 304) return;
    if (response.status !== 200)
      throw new Error(`webcal_fetch_failed: HTTP ${response.status}`);
    const { events, skipped } = parseIcsCalendar(response.body);
    if (skipped > 0 && events.length === 0 && skipped > 50)
      throw new Error(`webcal_parse_failed: ${skipped} events skipped, 0 parsed`);
    const etag = response.headers.etag ?? response.headers["ETag"] ?? null;
    const lastModified = response.headers["last-modified"] ?? response.headers["Last-Modified"] ?? null;
    const terminalCursor = etag ? `etag:${etag}` : lastModified ? `lm:${lastModified}` : "none";
    yield { changes: [], calendarChanges: events, ...(terminalCursor !== "none" ? { terminalCursor } : {}) };
  },
};
