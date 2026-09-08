import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isNull } from "drizzle-orm";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  connectorCalendarEvents,
  connectorEmails,
  ingestEvents,
} from "../src/infrastructure/database/schema.js";
import { ConnectorDocumentStore } from "@nxcore/connectors-module/document-store.js";
import { ConnectorDomainProjection } from "@nxcore/connectors-module/domain-projection.js";
import { purgeConnectorConnectionCascade } from "../src/modules/connectors/connection-purge.js";
import type { MemoryService } from "../src/modules/memory/service.js";
import type { KnowledgeService } from "../src/modules/knowledge/service.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const mailChange = (id: string) => ({
  kind: "upsert" as const,
  message: {
    providerMessageId: id,
    subject: `邮件 ${id}`,
    textBody: "正文",
    sentAt: "2026-09-01T09:00:00Z",
    addresses: [{ role: "from", address: "a@example.com" }],
  },
});

const calendarChange = (id: string) => ({
  kind: "upsert" as const,
  event: {
    providerEventId: id,
    title: `日程 ${id}`,
    startsAt: "2026-09-01T10:00:00Z",
    endsAt: "2026-09-01T11:00:00Z",
  },
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "connector-purge-"));
  dirs.push(dir);
  const client = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  const projection = new ConnectorDomainProjection(client.db, "local-user");
  const documentStore = new ConnectorDocumentStore(join(dir, "connector-documents"));

  const memoryCalls: Array<{ refs: string[]; prefix?: string }> = [];
  let memoryError: Error | null = null;
  const memory = {
    deleteDocumentsByCallerRefs: async (target: { refs: string[]; prefix?: string }) => {
      if (memoryError) throw memoryError;
      memoryCalls.push(target);
      return [];
    },
  } as unknown as MemoryService;

  const cleanupItems: Array<{ sourceKind: string; sourceId: string }> = [];
  const knowledge = {
    requestSourceCleanups: (items: Array<{ sourceKind: string; sourceId: string }>) => {
      cleanupItems.push(...items);
    },
  } as unknown as KnowledgeService;

  const ledgerInsert = (sourceKind: string, sourceId: string) =>
    client.db.insert(ingestEvents).values({
      id: `ing-${sourceId}`,
      sourceKind: sourceKind as never,
      sourceId,
      sourceVersion: 1,
      dataType: "mail",
      detectedBy: "source-kind",
      title: "t",
      contentHash: `hash-${sourceId}`,
      parsedId: "parsed-1",
      pipelines: { room: false, wiki: false, memory: true },
    }).run();

  return {
    client, projection, documentStore, memoryCalls, cleanupItems, ledgerInsert,
    setMemoryError: (error: Error | null) => (memoryError = error),
    memory: memory as MemoryService,
    knowledge: knowledge as KnowledgeService,
    log: { info: () => {}, warn: () => {} },
  };
}

describe("purgeConnectorConnectionCascade", () => {
  it("清域行/记忆/台账/knowledge/落盘文档，且不影响他连接", async () => {
    const s = await setup();
    const keep = { id: "conn-keep", provider: "gmail" as const };
    const drop = { id: "conn-drop", provider: "gmail" as const };

    const dropMail1 = s.projection.projectMail("gmail", drop.id, mailChange("m1"));
    const dropMail2 = s.projection.projectMail("gmail", drop.id, mailChange("m2"));
    const dropEvent = s.projection.projectCalendar("gmail", drop.id, calendarChange("e1"));
    const keepMail = s.projection.projectMail("gmail", keep.id, mailChange("m9"));
    s.ledgerInsert("mail", dropMail1.id!);
    s.ledgerInsert("mail", dropMail2.id!);
    s.ledgerInsert("calendar-event", dropEvent.id!);
    s.ledgerInsert("cloud-doc", `connector:gmail:${drop.id}:doc-1`);
    s.ledgerInsert("mail", keepMail.id!);
    await s.documentStore.write("gmail", drop.id, { providerDocumentId: "doc-1", title: "文档", markdown: "# 文档" });

    const summary = await purgeConnectorConnectionCascade(
      { db: s.client.db, memory: s.memory, knowledge: s.knowledge, documentStore: s.documentStore, ownerId: "local-user", log: s.log },
      drop,
    );

    expect(summary).toEqual({ mailRows: 2, calendarRows: 1, memoryDeleted: 0, ledgerRows: 4 });
    // 记忆批量删除：exact 域行 id + connector ref 前缀一次调用
    expect(s.memoryCalls).toHaveLength(1);
    const memoryCall = s.memoryCalls[0]!;
    expect(new Set(memoryCall.refs)).toEqual(new Set([dropMail1.id, dropMail2.id, dropEvent.id]));
    expect(memoryCall.prefix).toBe(`connector:gmail:${drop.id}:`);
    // knowledge 批量清理：4 条命中（含 cloud-doc 前缀命中），他连接的台账不进
    expect(s.cleanupItems).toHaveLength(4);
    // 域行清空、他连接保留
    expect(s.client.db.select().from(connectorEmails).all().map((row) => row.connectionName)).toEqual([keep.id]);
    expect(s.client.db.select().from(connectorCalendarEvents).all()).toEqual([]);
    // 台账软删：4 条 deletedAt 置位，他连接行活跃
    const active = s.client.db.select().from(ingestEvents).where(isNull(ingestEvents.deletedAt)).all();
    expect(active.map((row) => row.sourceId)).toEqual([keepMail.id]);
    // 落盘文档目录移除
    await expect(s.documentStore.list("gmail", drop.id)).resolves.toEqual([]);
  });

  it("幂等：重复执行为 no-op 不抛错", async () => {
    const s = await setup();
    const connection = { id: "conn-1", provider: "gmail" as const };
    s.projection.projectMail("gmail", connection.id, mailChange("m1"));
    await purgeConnectorConnectionCascade(
      { db: s.client.db, memory: s.memory, knowledge: s.knowledge, documentStore: s.documentStore, ownerId: "local-user", log: s.log },
      connection,
    );
    const second = await purgeConnectorConnectionCascade(
      { db: s.client.db, memory: s.memory, knowledge: s.knowledge, documentStore: s.documentStore, ownerId: "local-user", log: s.log },
      connection,
    );
    expect(second).toEqual({ mailRows: 0, calendarRows: 0, memoryDeleted: 0, ledgerRows: 0 });
    expect(s.cleanupItems).toHaveLength(0);
  });

  it("记忆删除失败向上抛（路由 500、连接保留、可重试）", async () => {
    const s = await setup();
    s.setMemoryError(new Error("memorycore down"));
    const connection = { id: "conn-1", provider: "gmail" as const };
    s.projection.projectMail("gmail", connection.id, mailChange("m1"));
    await expect(purgeConnectorConnectionCascade(
      { db: s.client.db, memory: s.memory, knowledge: s.knowledge, documentStore: s.documentStore, ownerId: "local-user", log: s.log },
      connection,
    )).rejects.toThrow("memorycore down");
    // 域行未被删除（后续步骤未执行）
    expect(s.client.db.select().from(connectorEmails).all()).toHaveLength(1);
  });
});
