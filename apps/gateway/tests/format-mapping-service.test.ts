import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncEventQueue } from "@nxcore/agent-runtime";
import type { AgentRuntime, RuntimeRun, StartRuntimeRunInput } from "@nxcore/agent-runtime";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { FormatMappingService } from "../src/modules/connectors/format-mapping-service.js";
import type { FormatMappingSpec } from "../src/modules/connectors/format-mapping-service.js";
import { connectorFormatMappings } from "../src/infrastructure/database/schema.js";
import { FormatMappingPendingError } from "@nxcore/connectors-module/format-mapper-port.js";

const databases: DatabaseClient[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.sqlite.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeService() {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-format-mapping-"));
  directories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  const service = new FormatMappingService(database.db, { info: () => {}, warn: () => {} });
  return { database, service };
}

/** 最小 AgentRuntime 桩：run 开始即调用 submit_format_mapping 工具提交给定映射。 */
const TOOL_RUN_INPUT = {
  runId: "stub",
  sessionId: "stub",
  runtimeSessionRef: null,
  prompt: "",
  pageLabel: null,
  roomId: null,
  captureMemory: false,
  recallMemory: false,
} as unknown as StartRuntimeRunInput;

function stubRuntime(service: FormatMappingService, payload: () => { service: string; recordKind: string } & Partial<FormatMappingSpec> | { error: string }): AgentRuntime {
  const tool = service.createSubmitTool();
  return {
    id: "stub",
    async getCapabilities() { return { streaming: false, reasoning: false, tools: true, steering: false, resume: false }; },
    async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
      const queue = new AsyncEventQueue<{ type: string; payload: unknown }>();
      void (async () => {
        try {
          queue.push({ type: "run.started", payload: {} });
          const params = payload();
          if (!("error" in params)) await tool.execute(TOOL_RUN_INPUT, params as Record<string, unknown>);
          queue.push({ type: "run.completed", payload: {} });
        } catch (error) {
          queue.push({ type: "run.failed", payload: { message: error instanceof Error ? error.message : String(error) } });
        } finally {
          queue.end();
        }
      })();
      return { runId: input.runId, runtimeSessionRef: "stub-1", events: queue as unknown as RuntimeRun["events"] };
    },
    async resume(): Promise<RuntimeRun> { throw new Error("unsupported"); },
    async sendInput(): Promise<void> { throw new Error("unsupported"); },
    async cancel(): Promise<void> {},
    async deleteSession(): Promise<void> {},
    async dispose(): Promise<void> {},
  };
}

function rowOf(database: DatabaseClient, service: string, kind: string) {
  return database.db.select().from(connectorFormatMappings).all()
    .find((row) => row.service === service && row.recordKind === kind);
}

const GMAIL_SPEC = {
  record: {
    providerMessageId: "$string(id)",
    providerThreadId: "threadId",
    subject: "subject",
    snippet: "snippet",
    textBody: "$base64decode($replace($replace($string(**[mimeType='text/plain'][0].body.data), '-', '+'), '_', '/'))",
    receivedAt: "$fromMillis($number(internalDate))",
    isRead: "$count($filter(labelIds, function($v){$v='UNREAD'})) = 0",
    isStarred: "$count($filter(labelIds, function($v){$v='STARRED'})) > 0",
    memberships: "labelIds",
    addresses: "payload.headers[$lowercase($string(name)) in ['from','to','cc','bcc','reply-to']].{'role': $lowercase($string(name)), 'address': $string(value)}",
  },
};

const GMAIL_SAMPLE = {
  id: "g1", threadId: "t1", snippet: "snip", internalDate: "1725530000000", historyId: "42",
  labelIds: ["INBOX", "UNREAD"],
  payload: { mimeType: "text/plain", headers: [{ name: "From", value: "a@x.com" }, { name: "To", value: "b@y.com" }], body: { data: "aGk=" } },
};

const OUTLOOK_SPEC = {
  record: {
    providerMessageId: "$string(id)",
    subject: "subject",
    snippet: "bodyPreview",
    htmlBody: "body[contentType='html'].content",
    receivedAt: "receivedDateTime",
    isRead: "$boolean(isRead)",
    isStarred: "flag.flagStatus='flagged'",
  },
  isTombstone: "$exists(`@removed`)",
  tombstoneId: "$string(id)",
};

const OUTLOOK_SAMPLE = {
  id: "o1", subject: "Re: Budget", bodyPreview: "Approved.", isRead: true,
  receivedDateTime: "2026-08-19T09:30:00Z", flag: { flagStatus: "flagged" },
  body: { contentType: "html", content: "<p>Approved.</p>" },
};

const OUTLOOK_TOMBSTONE_SAMPLE = { id: "o2", "@removed": { reason: "changed" } };

const CALENDAR_SPEC = {
  record: {
    providerEventId: "$string(id)",
    title: "$exists(summary) ? summary : '(无标题)'",
    startsAt: "$exists(start.dateTime) ? start.dateTime : (start.date & 'T00:00:00Z')",
    endsAt: "$exists(end.dateTime) ? end.dateTime : (end.date & 'T00:00:00Z')",
    allDay: "$exists(start.date) and $not($exists(start.dateTime))",
    organizer: "organizer.email ? {'role':'organizer','address':$lowercase(organizer.email),'displayName':organizer.displayName} : undefined",
    attendees: "[attendees[email].{'role':'attendee','address':$lowercase(email),'displayName':displayName}]",
  },
  isTombstone: "status='cancelled'",
  tombstoneId: "$string(id)",
};

const CALENDAR_SAMPLES = [
  { id: "e1", summary: "Standup", status: "confirmed", start: { dateTime: "2026-09-01T10:00:00+08:00", timeZone: "Asia/Shanghai" }, end: { dateTime: "2026-09-01T10:30:00+08:00" }, organizer: { email: "own@x.com", displayName: "Owner" }, attendees: [{ email: "a@y.com", displayName: "A" }] },
  { id: "e2", summary: "Holiday", status: "confirmed", start: { date: "2026-10-01" }, end: { date: "2026-10-02" } },
  { id: "e3", status: "cancelled" },
];

describe("FormatMappingService（格式映射体系）", () => {
  it("映射未就绪：抛 format_mapping_pending 并捕获样本", async () => {
    const { database, service } = await makeService();
    await expect(service.normalizeMail("gmail", GMAIL_SAMPLE)).rejects.toBeInstanceOf(FormatMappingPendingError);
    try {
      await service.normalizeMail("gmail", GMAIL_SAMPLE);
    } catch (error) {
      expect((error as FormatMappingPendingError).message).toContain("format_mapping_pending:gmail:mail");
    }
    const row = rowOf(database, "gmail", "mail");
    expect(row?.status).toBe("generating");
    expect((row?.samplesJson ?? []).length).toBe(1);
  });

  it("后台生成闭环：stub agent 提交 golden 映射 → 激活 → 后续同步直通", async () => {
    const { database, service } = await makeService();
    await expect(service.normalizeMail("gmail", GMAIL_SAMPLE)).rejects.toBeInstanceOf(FormatMappingPendingError);
    service.attachAgentRuntime(stubRuntime(service, () => ({ service: "gmail", recordKind: "mail", ...GMAIL_SPEC })));
    // 下一轮同步 tick 重试 → 重新触发后台生成（单飞）
    await expect(service.normalizeMail("gmail", GMAIL_SAMPLE)).rejects.toBeInstanceOf(FormatMappingPendingError);
    await new Promise((r) => setTimeout(r, 30));
    expect(rowOf(database, "gmail", "mail")?.status).toBe("active");
    const change = await service.normalizeMail("gmail", GMAIL_SAMPLE);
    expect(change).toEqual({
      kind: "upsert",
      message: {
        providerMessageId: "g1",
        providerThreadId: "t1",
        snippet: "snip",
        textBody: "hi",
        receivedAt: "2024-09-05T09:53:20.000Z",
        isRead: false,
        isStarred: false,
        memberships: ["INBOX", "UNREAD"],
        addresses: [
          { role: "from", address: "a@x.com" },
          { role: "to", address: "b@y.com" },
        ],
      },
    });
  });

  it("非法映射提交：回传逐条错误且不激活", async () => {
    const { database, service } = await makeService();
    await expect(service.normalizeMail("gmail", GMAIL_SAMPLE)).rejects.toBeInstanceOf(FormatMappingPendingError);
    const tool = service.createSubmitTool();
    // providerMessageId 表达式无匹配 → 回放后 canonical 校验失败（required）
    const result = (await tool.execute(TOOL_RUN_INPUT, {
      service: "gmail",
      recordKind: "mail",
      record: { providerMessageId: "not_here" },
    })) as { content: string };
    const outcome = JSON.parse(result.content) as { ok: boolean; errors?: string[] };
    expect(outcome.ok).toBe(false);
    expect(outcome.errors?.length ?? 0).toBeGreaterThan(0);
    expect(rowOf(database, "gmail", "mail")?.status).toBe("generating");
  });

  it("outlook golden：含 @removed 墓碑", async () => {
    const { database, service } = await makeService();
    await expect(service.normalizeMail("outlook", OUTLOOK_SAMPLE)).rejects.toBeInstanceOf(FormatMappingPendingError);
    await expect(service.normalizeMail("outlook", OUTLOOK_TOMBSTONE_SAMPLE)).rejects.toBeInstanceOf(FormatMappingPendingError);
    service.attachAgentRuntime(stubRuntime(service, () => ({ service: "outlook", recordKind: "mail", ...OUTLOOK_SPEC })));
    await expect(service.normalizeMail("outlook", OUTLOOK_SAMPLE)).rejects.toBeInstanceOf(FormatMappingPendingError);
    await new Promise((r) => setTimeout(r, 30));
    expect(rowOf(database, "outlook", "mail")?.status).toBe("active");
    expect(await service.normalizeMail("outlook", OUTLOOK_SAMPLE)).toEqual({
      kind: "upsert",
      message: {
        providerMessageId: "o1",
        subject: "Re: Budget",
        snippet: "Approved.",
        htmlBody: "<p>Approved.</p>",
        receivedAt: "2026-08-19T09:30:00Z",
        isRead: true,
        isStarred: true,
      },
    });
    expect(await service.normalizeMail("outlook", OUTLOOK_TOMBSTONE_SAMPLE)).toEqual({
      kind: "tombstone",
      providerMessageId: "o2",
    });
  });

  it("calendar golden：allDay 二态与 cancelled 墓碑", async () => {
    const { database, service } = await makeService();
    for (const sample of CALENDAR_SAMPLES) {
      await expect(service.normalizeCalendar("google-calendar", sample)).rejects.toBeInstanceOf(FormatMappingPendingError);
    }
    service.attachAgentRuntime(stubRuntime(service, () => ({ service: "google-calendar", recordKind: "calendar", ...CALENDAR_SPEC })));
    await expect(service.normalizeCalendar("google-calendar", CALENDAR_SAMPLES[0])).rejects.toBeInstanceOf(FormatMappingPendingError);
    await new Promise((r) => setTimeout(r, 30));
    expect(rowOf(database, "google-calendar", "calendar")?.status).toBe("active");
    expect(await service.normalizeCalendar("google-calendar", CALENDAR_SAMPLES[0])).toEqual({
      kind: "upsert",
      event: {
        providerEventId: "e1",
        title: "Standup",
        startsAt: "2026-09-01T10:00:00+08:00",
        endsAt: "2026-09-01T10:30:00+08:00",
        allDay: false,
        organizer: { role: "organizer", address: "own@x.com", displayName: "Owner" },
        attendees: [{ role: "attendee", address: "a@y.com", displayName: "A" }],
      },
    });
    expect(await service.normalizeCalendar("google-calendar", CALENDAR_SAMPLES[1])).toEqual({
      kind: "upsert",
      event: {
        providerEventId: "e2",
        title: "Holiday",
        startsAt: "2026-10-01T00:00:00Z",
        endsAt: "2026-10-02T00:00:00Z",
        allDay: true,
        // [...]=数组构造恒产出数组；无参与人时空数组（投影层安全）
        attendees: [],
      },
    });
    expect(await service.normalizeCalendar("google-calendar", CALENDAR_SAMPLES[2])).toEqual({
      kind: "tombstone",
      providerEventId: "e3",
    });
  });

  it("连续应用失败 ≥5：映射失效置 failed 并触发重生成", async () => {
    const { database, service } = await makeService();
    await expect(service.normalizeMail("gmail", GMAIL_SAMPLE)).rejects.toBeInstanceOf(FormatMappingPendingError);
    service.attachAgentRuntime(stubRuntime(service, () => ({ service: "gmail", recordKind: "mail", ...GMAIL_SPEC })));
    await expect(service.normalizeMail("gmail", GMAIL_SAMPLE)).rejects.toBeInstanceOf(FormatMappingPendingError);
    await new Promise((r) => setTimeout(r, 30));
    expect(rowOf(database, "gmail", "mail")?.status).toBe("active");
    // 断开 runtime：失效后的重生成不消费（否则桩会立即自愈回 active）
    service.attachAgentRuntime(null);
    // 上游格式漂移：字段全部缺失 → canonical 校验失败，连续 5 次后失效
    const drifted = { payload: { headers: [] } };
    for (let i = 0; i < 5; i++) {
      await expect(service.normalizeMail("gmail", drifted)).rejects.toBeInstanceOf(FormatMappingPendingError);
    }
    const row = rowOf(database, "gmail", "mail");
    expect(row?.status).toBe("failed");
    expect(row?.error ?? "").toContain("mapping_apply_failed");
  });

  it("pending 单飞去重：并发触发只生成一轮", async () => {
    const { service } = await makeService();
    await expect(service.normalizeMail("gmail", GMAIL_SAMPLE)).rejects.toBeInstanceOf(FormatMappingPendingError);
    const base = stubRuntime(service, () => ({ service: "gmail", recordKind: "mail", ...GMAIL_SPEC }));
    const starts: string[] = [];
    const countingRuntime: AgentRuntime = {
      ...base,
      async start(input: StartRuntimeRunInput) {
        starts.push(input.runId);
        await new Promise((r) => setTimeout(r, 20));
        return base.start(input);
      },
    };
    service.attachAgentRuntime(countingRuntime);
    const [first, second] = await Promise.allSettled([
      service.normalizeMail("gmail", GMAIL_SAMPLE),
      service.normalizeMail("gmail", GMAIL_SAMPLE),
    ]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");
    await new Promise((r) => setTimeout(r, 80));
    expect(starts.length).toBe(1);
  });
});
