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
      const calendarChanges: NormalizedCalendarChange[] = (data.items ?? []).map((item: any) => {
        if (item.status === "cancelled") return { kind: "tombstone", providerEventId: String(item.id) } as const;
        const start = item.start?.dateTime ?? `${item.start?.date}T00:00:00Z`;
        const end = item.end?.dateTime ?? `${item.end?.date}T00:00:00Z`;
        const address = (person: any) => person?.email ? { role: "attendee", displayName: person.displayName, address: String(person.email).toLowerCase() } : undefined;
        return { kind: "upsert", event: { providerEventId: String(item.id), title: String(item.summary ?? "(无标题)"), description: item.description ? String(item.description) : undefined, startsAt: start, endsAt: end, timeZone: item.start?.timeZone, location: item.location ? String(item.location) : undefined, status: item.status ? String(item.status) : undefined, organizer: address(item.organizer), attendees: (item.attendees ?? []).map(address).filter(Boolean), recurrence: item.recurrence ? { rules: item.recurrence } : undefined, providerRevision: item.etag ? String(item.etag) : undefined } } as const;
      });
      const next = data.nextPageToken ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ctx.providerScopeId)}/events?singleEvents=true&showDeleted=true&maxResults=2500&pageToken=${encodeURIComponent(data.nextPageToken)}` : "";
      yield { changes: [], calendarChanges, ...(next ? { continuation: next } : data.nextSyncToken ? { terminalCursor: String(data.nextSyncToken) } : {}) };
      url = next;
    } while (url);
  },
};
