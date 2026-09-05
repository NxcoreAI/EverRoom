import type { NormalizedCalendarChange } from "@nxcore/connector-contract";
import type { SyncProviderDefinition } from "./types.js";

/** Google Calendar：scope = 每个日历一条（calendarList 发现）；游标 = syncToken。 */
export const googleCalendarSyncProvider: SyncProviderDefinition = {
  provider: "google-calendar",
  engine: "nango",
  dataTypes: ["calendar"],
  auth: {
    channel: "nango-oauth",
    nango: {
      configKeyEnv: ["NXCORE_NANGO_CONNECTOR_GOOGLE_CALENDAR_CONFIG_KEY"],
      configKeyDefault: "google-calendar",
      integrationProvider: "google-calendar",
      credential: "google",
      oauthScopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/calendar.readonly"],
    },
  },
  defaultScopes: [{ providerScopeId: "primary", displayName: "Primary calendar" }],
  ui: { label: "Google Calendar", category: "calendar", iconKey: "google-calendar" },
  async discoverScopes(ctx) {
    const data = await ctx.proxyGet("https://www.googleapis.com/calendar/v3/users/me/calendarList");
    return (data.items ?? []).map((item: any) => ({
      providerScopeId: String(item.id),
      displayName: String(item.summary ?? item.id),
    }));
  },
  async *pull(ctx, mode) {
    let url =
      mode === "incremental" && ctx.sourceCursor
        ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ctx.providerScopeId)}/events?singleEvents=true&showDeleted=true&maxResults=2500&syncToken=${encodeURIComponent(ctx.sourceCursor)}`
        : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ctx.providerScopeId)}/events?singleEvents=true&showDeleted=true&maxResults=2500&timeMin=1970-01-01T00:00:00Z`;
    do {
      const data = await ctx.proxyGet(url);
      const calendarChanges: NormalizedCalendarChange[] = [];
      for (const item of data.items ?? [])
        calendarChanges.push(await ctx.normalizeCalendar(item));
      const next = data.nextPageToken ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ctx.providerScopeId)}/events?singleEvents=true&showDeleted=true&maxResults=2500&pageToken=${encodeURIComponent(data.nextPageToken)}` : "";
      yield { changes: [], calendarChanges, ...(next ? { continuation: next } : data.nextSyncToken ? { terminalCursor: String(data.nextSyncToken) } : {}) };
      url = next;
    } while (url);
  },
};
