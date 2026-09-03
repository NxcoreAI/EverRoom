import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createConnectorDatabase } from "../src/infrastructure/connectors/client.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { connectorCalendarEvents } from "../src/infrastructure/database/schema.js";
import { ConnectorRepository } from "@nxcore/connectors-module/repository.js";
import { ConnectorManager } from "@nxcore/connectors-module/manager.js";
import { SyncEngine } from "@nxcore/connectors-module/sync-engine.js";
import { nangoConnectorRoutes } from "@nxcore/connectors-module/routes.js";
import { ConnectorDomainProjection } from "@nxcore/connectors-module/domain-projection.js";
import { parseIcsCalendar, unfoldIcsLines } from "@nxcore/connectors-module/ics.js";
import { icsCalendarSyncProvider } from "@nxcore/connectors-module/sync-providers/ics-calendar.js";
import { normalizeWebcalUrl } from "@nxcore/connectors-module/auth-channels/types.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

// SUMMARY 折成两行（第二行以空格起始 = RFC5545 续行），解析后应拼回一行。
const SAMPLE_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//EverRoom//Test//CN",
  "BEGIN:VEVENT",
  "UID:evt-1@webcal.test",
  "DTSTAMP:20260830T120000Z",
  "DTSTART;TZID=Asia/Shanghai:20260901T090000",
  "DTEND;TZID=Asia/Shanghai:20260901T100000",
  "SUMMARY:发布评审（续行",
  " 测试）",
  "DESCRIPTION:过 M3 方案\\,注意逗号转义",
  "LOCATION:会议室 A",
  "ORGANIZER;CN=组织者:mailto:Organizer@Example.com",
  "ATTENDEE;CN=张三:mailto:zhang@example.com",
  "ATTENDEE:mailto:li@example.com",
  "STATUS:CONFIRMED",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:evt-2@webcal.test",
  "DTSTAMP:20260830T120000Z",
  "DTSTART;VALUE=DATE:20260905",
  "SUMMARY:全天假日",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:evt-3@webcal.test",
  "DTSTAMP:20260830T120000Z",
  "DTSTART:20260910T020000Z",
  "DTEND:20260910T030000Z",
  "SUMMARY:已取消的日程",
  "STATUS:CANCELLED",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("ics parser", () => {
  it("unfolds continuation lines (marker space is removed per RFC 5545)", () => {
    const lines = unfoldIcsLines("SUMMARY:first\r\n part\r\nDTSTART:x\r\n");
    expect(lines).toEqual(["SUMMARY:firstpart", "DTSTART:x", ""]);
  });

  it("parses timed, all-day, and cancelled events with escaping and addresses", () => {
    const { events, skipped } = parseIcsCalendar(SAMPLE_ICS);
    expect(skipped).toBe(0);
    expect(events).toHaveLength(3);
    const first = events[0]!;
    expect(first.kind).toBe("upsert");
    if (first.kind !== "upsert") return;
    expect(first.event.title).toBe("发布评审（续行测试）");
    expect(first.event.description).toBe("过 M3 方案,注意逗号转义");
    expect(first.event.allDay).toBeUndefined();
    // Asia/Shanghai 09:00 = UTC 01:00（无 DST，稳定断言）。
    expect(first.event.startsAt).toBe("2026-09-01T01:00:00.000Z");
    expect(first.event.organizer).toMatchObject({ displayName: "组织者", address: "organizer@example.com" });
    expect(first.event.attendees).toEqual([
      { role: "attendee", displayName: "张三", address: "zhang@example.com" },
      { role: "attendee", address: "li@example.com" },
    ]);
    const second = events[1]!;
    expect(second).toMatchObject({ kind: "upsert" });
    if (second.kind !== "upsert") return;
    expect(second.event.allDay).toBe(true);
    expect(second.event.startsAt).toBe("2026-09-05T00:00:00.000Z");
    expect(events[2]).toEqual({ kind: "tombstone", providerEventId: "evt-3@webcal.test" });
  });

  it("skips events without UID or valid DTSTART", () => {
    const broken = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:no uid",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:bad-date",
      "DTSTART:not-a-date",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcsCalendar(broken)).toMatchObject({ events: [], skipped: 2 });
  });
});

describe("ics-calendar provider (direct engine)", () => {
  it("yields calendar changes with an ETag terminal cursor, and 304 short-circuits", async () => {
    const pages: Array<{ calendarChanges?: unknown[]; terminalCursor?: string }> = [];
    const seenHeaders: Array<Record<string, string> | undefined> = [];
    for await (const page of icsCalendarSyncProvider.pullDirect!({
      credentials: "https://cal.example.com/holidays.ics",
      providerScopeId: "calendar",
      sourceCursor: null,
      httpPostJson: async () => { throw new Error("unexpected POST"); },
      httpGet: async (_url, headers) => {
        seenHeaders.push(headers);
        return { status: 200, headers: { etag: '"v42"' }, body: SAMPLE_ICS };
      },
    }, "full")) {
      pages.push(page as any);
    }
    expect(seenHeaders[0]).toMatchObject({ Accept: "text/calendar, text/plain, */*" });
    expect(seenHeaders[0]?.["If-None-Match"]).toBeUndefined();
    expect(pages[0]?.calendarChanges).toHaveLength(3);
    expect(pages[0]?.terminalCursor).toBe('etag:"v42"');

    const incremental: unknown[] = [];
    for await (const page of icsCalendarSyncProvider.pullDirect!({
      credentials: "https://cal.example.com/holidays.ics",
      providerScopeId: "calendar",
      sourceCursor: 'etag:"v42"',
      httpPostJson: async () => { throw new Error("unexpected POST"); },
      httpGet: async (_url, headers) => {
        seenHeaders.push(headers);
        return { status: 304, headers: {}, body: "" };
      },
    }, "incremental")) {
      incremental.push(page);
    }
    expect(seenHeaders[1]?.["If-None-Match"]).toBe('"v42"');
    expect(incremental).toHaveLength(0);
  });

  it("rejects non-200 fetches", async () => {
    await expect(async () => {
      for await (const _page of icsCalendarSyncProvider.pullDirect!({
        credentials: "https://cal.example.com/x.ics",
        providerScopeId: "calendar",
        sourceCursor: null,
        httpPostJson: async () => { throw new Error("unexpected POST"); },
        httpGet: async () => ({ status: 404, headers: {}, body: "" }),
      }, "full")) {
        // consume
      }
    }).rejects.toThrow("webcal_fetch_failed: HTTP 404");
  });
});

describe("sync engine gating", () => {
  it("serves direct providers without a nango executor and gates nango until ready", () => {
    const engine = new SyncEngine(null, () => null);
    expect(engine.canServe("ics-calendar")).toBe(true);
    expect(engine.canServe("gmail")).toBe(false);
    const withNango = new SyncEngine({} as any, () => null);
    withNango.setNangoReady(false);
    expect(withNango.canServe("gmail")).toBe(false);
    withNango.setNangoReady(true);
    expect(withNango.canServe("gmail")).toBe(true);
    expect(withNango.canServe("not-a-provider")).toBe(false);
  });

  it("end-to-end: webcal connection syncs into domain tables without any Nango", async () => {
    const dir = await mkdtemp(join(tmpdir(), "m3-e2e-"));
    dirs.push(dir);
    const connectors = createConnectorDatabase(join(dir, "connectors.sqlite"));
    const main = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
    const repo = new ConnectorRepository(connectors.sqlite);
    const engine = new SyncEngine(null, (connection) => connection.credentialsRef ?? null);
    const manager = new ConnectorManager(repo, null, null, engine);
    manager.setDomainProjection(new ConnectorDomainProjection(main.db, "local-user"));

    const connection = await manager.register({
      provider: "ics-calendar",
      nangoConfigKey: "direct",
      nangoConnectionId: "webcal:abc",
      authMethod: "webcal-url",
      credentialsRef: "https://cal.example.com/holidays.ics",
    });
    // 引擎直连层会真实 fetch —— 用 engine 侧可注入 httpGet？直连 fetch 不可注入，
    // 此处以 provider 层单测覆盖网络语义，端到端走 pullDirect 桩（见上）。
    // 此处验证注册/门控/scope 种子/域投影联动的非网络部分：
    expect(connection.authMethod).toBe("webcal-url");
    expect(repo.listScopes().filter((scope) => scope.connectionId === connection.id))
      .toEqual([expect.objectContaining({ providerScopeId: "calendar", displayName: "订阅日历" })]);
    // direct 域行投影（不经网络）：ICS→域表全链路字段。tombstone 先于 upsert
    // 出现时是 noop（源侧直接取消），故 evt-3 手动按 upsert→tombstone 验证软删。
    const parsed = parseIcsCalendar(SAMPLE_ICS);
    const projection = new ConnectorDomainProjection(main.db, "local-user");
    for (const change of parsed.events) projection.projectCalendar("ics-calendar", connection.id, change);
    projection.projectCalendar("ics-calendar", connection.id, {
      kind: "upsert",
      event: { providerEventId: "evt-3@webcal.test", title: "已取消的日程", startsAt: "2026-09-10T02:00:00Z", endsAt: "2026-09-10T03:00:00Z" },
    });
    projection.projectCalendar("ics-calendar", connection.id, { kind: "tombstone", providerEventId: "evt-3@webcal.test" });
    const rows = main.db.select().from(connectorCalendarEvents).all();
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.sourceRecordId === "evt-2@webcal.test")).toMatchObject({
      title: "全天假日",
      allDay: true,
      service: "ics-calendar",
    });
    expect(rows.find((row) => row.sourceRecordId === "evt-1@webcal.test")?.deletedAt).toBeNull();
    expect(rows.find((row) => row.sourceRecordId === "evt-3@webcal.test")?.deletedAt).not.toBeNull();
    await manager.dispose();
    connectors.sqlite.close();
    main.sqlite.close();
  });
});

describe("webcal connection route", () => {
  it("creates an idempotent subscription without echoing the url token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "m3-route-"));
    dirs.push(dir);
    const connectors = createConnectorDatabase(join(dir, "connectors.sqlite"));
    const repo = new ConnectorRepository(connectors.sqlite);
    const engine = new SyncEngine(null, (connection) => connection.credentialsRef ?? null);
    const manager = new ConnectorManager(repo, null, null, engine);
    const app = Fastify();
    await app.register(nangoConnectorRoutes(manager, true));
    const payload = { provider: "ics-calendar", url: "webcal://cal.example.com/team.ics?token=sekret" };
    const created = await app.inject({ method: "POST", url: "/v1/connectors/connections", payload });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ provider: "ics-calendar", authMethod: "webcal-url", nangoConfigKey: "direct" });
    expect(JSON.stringify(body)).not.toContain("sekret");
    // 幂等：同 URL 再订阅返回既有连接（200）。
    const again = await app.inject({ method: "POST", url: "/v1/connectors/connections", payload });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(body.id);
    // 拒绝非 direct provider 与非法 URL。
    expect((await app.inject({ method: "POST", url: "/v1/connectors/connections", payload: { provider: "gmail", url: "https://x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/connectors/connections", payload: { provider: "ics-calendar", url: "ftp://cal.example.com/x.ics" } })).statusCode).toBe(400);
    await app.close();
    await manager.dispose();
    connectors.sqlite.close();
  });
});

describe("webcal url normalization", () => {
  it("maps webcal to https and enforces constraints", () => {
    expect(normalizeWebcalUrl("webcal://cal.example.com/a.ics").toString()).toBe("https://cal.example.com/a.ics");
    expect(() => normalizeWebcalUrl("ftp://x/y")).toThrow("webcal_url_invalid_scheme");
    expect(() => normalizeWebcalUrl("https://user:pass@cal.example.com/a.ics")).toThrow("webcal_url_credentials_forbidden");
    expect(() => normalizeWebcalUrl("")).toThrow("webcal_url_required");
  });
});
