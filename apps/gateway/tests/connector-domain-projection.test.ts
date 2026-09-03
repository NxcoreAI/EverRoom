import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createConnectorDatabase } from "../src/infrastructure/connectors/client.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  connectorCalendarEvents,
  connectorEmails,
  entityDocLinks,
  routeDecisions,
  roomSourceMemberships,
} from "../src/infrastructure/database/schema.js";
import { ConnectorRepository } from "@nxcore/connectors-module/repository.js";
import { ConnectorManager } from "@nxcore/connectors-module/manager.js";
import {
  ConnectorDomainProjection,
  backfillDomainProjection,
  parseConnectorSourceRef,
  rewriteConnectorRefIdentities,
} from "@nxcore/connectors-module/domain-projection.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function setupMain() {
  const dir = await mkdtemp(join(tmpdir(), "domain-projection-"));
  dirs.push(dir);
  const client = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  return { client, dir };
}

async function setupBoth() {
  const dir = await mkdtemp(join(tmpdir(), "domain-projection-"));
  dirs.push(dir);
  const connectors = createConnectorDatabase(join(dir, "connectors.sqlite"));
  const main = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  return { connectors, main, dir };
}

const mailChange = {
  kind: "upsert" as const,
  message: {
    providerMessageId: "msg-1",
    providerThreadId: "thread-1",
    subject: "季度总结",
    textBody: "正文内容",
    sentAt: "2026-08-19T09:00:00Z",
    receivedAt: "2026-08-19T09:00:01Z",
    memberships: ["INBOX", "STARRED"],
    attachments: [{ providerId: "a1", filename: "note.txt" }],
    addresses: [
      { role: "from", displayName: "张三", address: "zhang@example.com" },
      { role: "to", address: "me@example.com" },
      { role: "cc", address: "cc@example.com" },
      { role: "reply-to", address: "reply@example.com" },
    ],
  },
};

describe("connector domain projection", () => {
  it("maps NormalizedMail onto connector_emails with CLI-path column semantics", async () => {
    const { client } = await setupMain();
    const projection = new ConnectorDomainProjection(client.db, "local-user");
    const result = projection.projectMail("gmail", "conn-1", mailChange);
    expect(result).toMatchObject({ outcome: "inserted" });
    expect(result.id).toBeTruthy();
    const row = client.db.select().from(connectorEmails).where(eq(connectorEmails.service, "gmail")).get();
    expect(row).toMatchObject({
      ownerId: "local-user",
      service: "gmail",
      connectionName: "conn-1",
      sourceRecordId: "msg-1",
      messageId: "msg-1",
      threadId: "thread-1",
      senderName: "张三",
      senderAddress: "zhang@example.com",
      recipients: [{ address: "me@example.com" }, { address: "cc@example.com" }],
      subject: "季度总结",
      sentAt: new Date("2026-08-19T09:00:00Z"),
      bodyText: "正文内容",
      labels: ["INBOX", "STARRED"],
      hasAttachments: true,
      deletedAt: null,
    });
    client.sqlite.close();
  });

  it("falls back to stripped html for the body and （无主题） for missing subjects", async () => {
    const { client } = await setupMain();
    const projection = new ConnectorDomainProjection(client.db, "local-user");
    projection.projectMail("outlook", "conn-1", {
      kind: "upsert",
      message: {
        providerMessageId: "m-html",
        htmlBody: "<div>第一行</div><p>第二行&nbsp;&amp;更多</p><script>alert(1)</script>",
        addresses: [{ role: "from", address: "a@e.com" }],
      },
    });
    const row = client.db.select().from(connectorEmails).where(eq(connectorEmails.sourceRecordId, "m-html")).get();
    expect(row?.subject).toBe("（无主题）");
    expect(row?.bodyText).toContain("第一行");
    // &nbsp;&amp; 依次解码为空格与 &。
    expect(row?.bodyText).toContain("第二行 &更多");
    expect(row?.bodyText).not.toContain("alert");
    expect(row?.hasAttachments).toBe(false);
    client.sqlite.close();
  });

  it("is idempotent per unique key and reports updated on content change", async () => {
    const { client } = await setupMain();
    const projection = new ConnectorDomainProjection(client.db, "local-user");
    expect(projection.projectMail("gmail", "conn-1", mailChange).outcome).toBe("inserted");
    expect(projection.projectMail("gmail", "conn-1", mailChange).outcome).toBe("unchanged");
    const revised = { kind: "upsert" as const, message: { ...mailChange.message, subject: "季度总结（修订）" } };
    expect(projection.projectMail("gmail", "conn-1", revised).outcome).toBe("updated");
    // 不同连接（connectionName）不串行：同 providerMessageId 各自成行。
    projection.projectMail("gmail", "conn-2", mailChange);
    expect(client.db.select().from(connectorEmails).all()).toHaveLength(2);
    client.sqlite.close();
  });

  it("soft-deletes on mail tombstones and stays noop afterwards", async () => {
    const { client } = await setupMain();
    const projection = new ConnectorDomainProjection(client.db, "local-user");
    projection.projectMail("gmail", "conn-1", mailChange);
    expect(projection.projectMail("gmail", "conn-1", { kind: "tombstone", providerMessageId: "msg-1" })).toMatchObject({ outcome: "deleted" });
    const row = client.db.select().from(connectorEmails).get();
    expect(row?.deletedAt).not.toBeNull();
    expect(projection.projectMail("gmail", "conn-1", { kind: "tombstone", providerMessageId: "msg-1" }).outcome).toBe("noop");
    // 复活（同一 upsert 重放）清掉 deletedAt。
    expect(projection.projectMail("gmail", "conn-1", mailChange).outcome).toBe("updated");
    expect(client.db.select().from(connectorEmails).get()?.deletedAt).toBeNull();
    client.sqlite.close();
  });

  it("maps NormalizedCalendarEvent onto connector_calendar_events", async () => {
    const { client } = await setupMain();
    const projection = new ConnectorDomainProjection(client.db, "local-user");
    projection.projectCalendar("google-calendar", "conn-1", {
      kind: "upsert",
      event: {
        providerEventId: "ev-1",
        title: "评审会",
        description: "过方案",
        startsAt: "2026-08-20T02:00:00Z",
        endsAt: "2026-08-20T03:00:00Z",
        location: "会议室 A",
        status: "confirmed",
        organizer: { role: "organizer", displayName: "组织者", address: "o@e.com" },
        attendees: [{ role: "attendee", address: "a@e.com" }, { role: "attendee", address: "b@e.com" }],
      },
    });
    const row = client.db.select().from(connectorCalendarEvents).get();
    expect(row).toMatchObject({
      service: "google-calendar",
      connectionName: "conn-1",
      sourceRecordId: "ev-1",
      eventId: "ev-1",
      title: "评审会",
      description: "过方案",
      organizer: { name: "组织者", address: "o@e.com" },
      attendees: [{ address: "a@e.com" }, { address: "b@e.com" }],
      startAt: new Date("2026-08-20T02:00:00Z"),
      endAt: new Date("2026-08-20T03:00:00Z"),
      allDay: false,
      status: "confirmed",
      location: "会议室 A",
      deletedAt: null,
    });
    expect(projection.projectCalendar("google-calendar", "conn-1", { kind: "tombstone", providerEventId: "ev-1" })).toMatchObject({ outcome: "deleted" });
    expect(client.db.select().from(connectorCalendarEvents).get()?.deletedAt).not.toBeNull();
    client.sqlite.close();
  });
});

describe("parseConnectorSourceRef", () => {
  it("parses mail, calendar, and document refs including colon-bearing ids", () => {
    expect(parseConnectorSourceRef("connector:gmail:conn-1:mail:abc123")).toEqual({
      provider: "gmail", connectionId: "conn-1", kind: "mail", recordId: "abc123",
    });
    expect(parseConnectorSourceRef("connector:google-calendar:conn-1:calendar:ev:with:colons")).toEqual({
      provider: "google-calendar", connectionId: "conn-1", kind: "calendar", recordId: "ev:with:colons",
    });
    expect(parseConnectorSourceRef("connector:google-docs:conn-1:doc-9")).toEqual({
      provider: "google-docs", connectionId: "conn-1", kind: "document", recordId: "doc-9",
    });
  });

  it("rejects non-connector and malformed ids", () => {
    expect(parseConnectorSourceRef("a1b2c3")).toBeNull();
    expect(parseConnectorSourceRef("connector:only-provider")).toBeNull();
    expect(parseConnectorSourceRef("connector:gmail:conn-1:mail:")).toBeNull();
  });
});

describe("manager domain projection wiring", () => {
  it("projects synced mail (including tombstones) into the main database while keeping the memory sink", async () => {
    const { connectors, main } = await setupBoth();
    const repo = new ConnectorRepository(connectors.sqlite);
    const connection = repo.registerConnection({ provider: "gmail", service: "g", connectionName: "nango-c" });
    const scope = repo.ensureScope(connection.id, "me", "Mailbox");
    const executor = {
      async *pull() {
        yield {
          changes: [
            mailChange,
            { kind: "tombstone" as const, providerMessageId: "m-gone" },
          ],
        };
      },
    } as any;
    const manager = new ConnectorManager(repo, executor);
    manager.setDomainProjection(new ConnectorDomainProjection(main.db, "local-user"));
    const seen: unknown[] = [];
    manager.setMemorySink(async (input) => { seen.push(input); });
    const run = manager.trigger(scope.id, "full");
    await manager.dispose();
    expect(repo.getRun(run.id)).toMatchObject({ status: "completed" });
    // memorySink 语义不变：upsert 进、tombstone 不进。
    expect(seen).toHaveLength(1);
    const row = main.db.select().from(connectorEmails).get();
    expect(row).toMatchObject({ service: "gmail", connectionName: connection.id, sourceRecordId: "msg-1", subject: "季度总结" });
    expect(row?.deletedAt).toBeNull();
    clientclose(connectors, main);
  });

  it("soft-fails when the projection throws: run completes and a sync failure is recorded", async () => {
    const { connectors, main } = await setupBoth();
    const repo = new ConnectorRepository(connectors.sqlite);
    const connection = repo.registerConnection({ provider: "gmail", service: "g", connectionName: "nango-c" });
    const scope = repo.ensureScope(connection.id, "me", "Mailbox");
    const executor = { async *pull() { yield { changes: [mailChange] }; } } as any;
    const manager = new ConnectorManager(repo, executor);
    manager.setDomainProjection({
      projectMail: () => { throw new Error("projection down"); },
      projectCalendar: () => { throw new Error("projection down"); },
    } as any);
    const seen: unknown[] = [];
    manager.setMemorySink(async (input) => { seen.push(input); });
    const run = manager.trigger(scope.id, "full");
    await manager.dispose();
    expect(repo.getRun(run.id)).toMatchObject({ status: "completed" });
    expect(seen).toHaveLength(1);
    // listFailures 将 kind 列别名为 category 返回（better-sqlite3 返回 unknown[]）。
    const failures = repo.listFailures() as Array<{ category: string; runId: string }>;
    expect(failures.some((failure) => failure.category === "domain_projection" && failure.runId === run.id)).toBe(true);
    clientclose(connectors, main);
  });
});

describe("connector domain backfill", () => {
  it("replays connector_records through the same projection, idempotently", async () => {
    const { connectors, main } = await setupBoth();
    const repo = new ConnectorRepository(connectors.sqlite);
    const connection = repo.registerConnection({ provider: "gmail", service: "g", connectionName: "nango-c" });
    const scope = repo.ensureScope(connection.id, "me", "Mailbox");
    const fence = repo.acquireLease(scope.id, "owner")!;
    const run = repo.createRun(scope.id, "full");
    repo.applyPage(scope.id, run.id, fence, [mailChange]);
    repo.finishRun(run.id, "completed");
    // 回填前主库为空；回填后邮件经同一投影落域表。
    expect(main.db.select().from(connectorEmails).all()).toHaveLength(0);
    const first = backfillDomainProjection(main.db, repo, "local-user");
    expect(first).toMatchObject({ connections: 1, mail: 1, failures: 0 });
    const row = main.db.select().from(connectorEmails).get();
    expect(row).toMatchObject({ service: "gmail", connectionName: connection.id, sourceRecordId: "msg-1", subject: "季度总结" });
    // 幂等：重复回填不再新增行、计数不再增长（unchanged 不计入）。
    const second = backfillDomainProjection(main.db, repo, "local-user");
    expect(second).toMatchObject({ connections: 1, mail: 0, failures: 0 });
    expect(main.db.select().from(connectorEmails).all()).toHaveLength(1);
    clientclose(connectors, main);
  });
});

function clientclose(connectors: { sqlite: { close: () => void } }, main: { sqlite: { close: () => void } }) {
  connectors.sqlite.close();
  main.sqlite.close();
}

describe("M4 identity rewrite", () => {
  it("rewrites connector refs to domain row ids across identity tables and dedupes", async () => {
    const { client } = await setupMain();
    const projection = new ConnectorDomainProjection(client.db, "local-user");
    const result = projection.projectMail("gmail", "conn-1", mailChange);
    const rowId = result.id!;
    const ref = "connector:gmail:conn-1:mail:msg-1";
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);
    // memberships：ref 行 + 既有同 id 的 CLI 行（撞车场景）。
    client.db.insert(roomSourceMemberships).values([
      { id: "m-ref", roomId: "room-1", sourceKind: "mail", sourceId: ref, sourceVersion: 1, role: "primary", evidenceGroupKey: ref, updatedAt: earlier },
      { id: "m-cli", roomId: "room-1", sourceKind: "mail", sourceId: rowId, sourceVersion: 1, role: "primary", evidenceGroupKey: rowId, updatedAt: now },
    ]).run();
    client.db.insert(routeDecisions).values({
      id: "d-ref", sourceKind: "mail", sourceId: ref, sourceVersion: 1,
      sourceTitle: "季度总结", confidence: 1, status: "linked", decidedBy: "resolution", createdAt: now,
    }).run();
    client.db.insert(entityDocLinks).values({
      id: "l-ref", entityId: "ent-1", sourceKind: "mail", sourceId: ref, sourceVersion: 1,
      role: "mention", salience: 1, evidence: "ref link", evidenceGroupKey: "ref", decidedBy: "resolution", updatedAt: now,
    }).run();
    const summary = rewriteConnectorRefIdentities(client.db);
    // 同一 ref 出现在三张表：按字符串去重计数（refs=1），一次改写覆盖全部表。
    expect(summary).toMatchObject({ refs: 1, rewritten: 1, unresolved: 0, deduped: { memberships: 1, entityLinks: 0 } });
    // 六表改写后：决策与链接都指向域行 id；membership 撞车保留最新（CLI 行）。
    expect(client.db.select().from(routeDecisions).all().every((row) => row.sourceId === rowId)).toBe(true);
    expect(client.db.select().from(entityDocLinks).all().every((row) => row.sourceId === rowId)).toBe(true);
    expect(client.db.select().from(roomSourceMemberships).all()).toEqual([
      expect.objectContaining({ id: "m-cli", sourceId: rowId }),
    ]);
    // 幂等：再跑一次为 no-op（refs 归零）。
    expect(rewriteConnectorRefIdentities(client.db).refs).toBe(0);
    // 不可解析的 ref 计 unresolved、原地不动。
    client.db.insert(routeDecisions).values({
      id: "d-bad", sourceKind: "mail", sourceId: "connector:gmail:gone:mail:missing", sourceVersion: 1,
      sourceTitle: "x", confidence: 0, status: "awaiting_review", decidedBy: "resolution", createdAt: now,
    }).run();
    const second = rewriteConnectorRefIdentities(client.db);
    expect(second).toMatchObject({ refs: 1, rewritten: 0, unresolved: 1 });
    expect(client.db.select().from(routeDecisions).where(eq(routeDecisions.id, "d-bad")).get()?.sourceId)
      .toBe("connector:gmail:gone:mail:missing");
    client.sqlite.close();
  });
});
