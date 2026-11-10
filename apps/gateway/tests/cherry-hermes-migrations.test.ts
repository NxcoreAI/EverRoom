import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { DataMigrationService, type NormalizedExternalThread } from "../src/modules/data-migrations/service.js";

const dirs: string[] = [];
const migrationsDir = join(import.meta.dirname, "../drizzle");

const thread = (content: string): NormalizedExternalThread => ({
  stableKey: "cherry:topic-1",
  externalSessionId: "topic-1",
  title: "发布计划",
  messages: [
    { stableKey: "m1", role: "user", content, occurredAt: "2026-01-01T00:00:00.000Z", attachments: [{ sourceKey: "migration:cherry:src:file:1", name: "roadmap.pdf", mimeType: "application/pdf", fileId: "file-1" }] },
    { stableKey: "m2", role: "assistant", content: "这是计划", occurredAt: "2026-01-01T00:00:01.000Z" },
  ],
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "everroom-cherry-")); dirs.push(directory);
  const database = createDatabase(join(directory, "gateway.sqlite"), migrationsDir);
  return { database, service: new DataMigrationService(database.db, database.sqlite) };
}

afterEach(async () => { await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

/** 幂等信号：同一线程是否被本次运行重新写入（import_version 自增）。 */
const importVersionFor = (service: DataMigrationService): number =>
  (service["sqlite"].prepare("SELECT import_version v FROM external_agent_threads").get() as { v: number }).v;

describe("cherry/hermes migration foundation", () => {
  it("seeds capability states for cherry on begin and activates sync after completion", async () => {
    const { database, service } = await setup();
    const started = service.begin({ provider: "cherry", transport: "directory", stableSourceKey: "root", displayName: "Cherry Studio" });
    expect(service.getCapabilities(started.source.id)).toMatchObject({
      importState: "available", syncState: "available",
      onDemandState: "not_available", writeBackState: "not_available", nativeRestoreState: "available",
    });
    service.appendThreads(started.run.id, [thread("帮我排期")]);
    await service.finish(started.run.id);
    await service.idle();
    expect(service.getCapabilities(started.source.id)).toMatchObject({ importState: "active", syncState: "active" });
    service.setCapability(started.source.id, { syncState: "paused" });
    expect(service.getCapabilities(started.source.id)?.syncState).toBe("paused");
    service.dispose();
    database.sqlite.close();
  });

  it("re-importing identical threads is a zero-task operation", async () => {
    const { database, service } = await setup();
    const first = service.begin({ provider: "cherry", transport: "directory", stableSourceKey: "root", displayName: "Cherry Studio" });
    service.appendThreads(first.run.id, [thread("帮我排期")]);
    await service.finish(first.run.id);
    await service.idle();
    const versionAfterFirst = (database.sqlite.prepare("SELECT import_version v FROM external_agent_threads").get() as { v: number }).v;

    const second = service.begin({ provider: "cherry", transport: "directory", stableSourceKey: "root", displayName: "Cherry Studio" });
    service.appendThreads(second.run.id, [thread("帮我排期")]);
    await service.finish(second.run.id);
    await service.idle();
    expect(database.sqlite.prepare("SELECT count(*) count FROM migration_jobs").get()).toEqual({ count: 0 });
    const versionAfterSecond = (database.sqlite.prepare("SELECT import_version v FROM external_agent_threads").get() as { v: number }).v;
    expect(versionAfterSecond).toBe(versionAfterFirst);
    service.dispose();
    database.sqlite.close();
  });

  it("changed content re-imports the thread and bumps its version", async () => {
    const { database, service } = await setup();
    const first = service.begin({ provider: "cherry", transport: "directory", stableSourceKey: "root", displayName: "Cherry Studio" });
    service.appendThreads(first.run.id, [thread("帮我排期")]);
    await service.finish(first.run.id);
    await service.idle();
    expect(importVersionFor(service)).toBe(1);

    const changed = service.begin({ provider: "cherry", transport: "directory", stableSourceKey: "root", displayName: "Cherry Studio" });
    service.appendThreads(changed.run.id, [thread("帮我重新排期")]);
    await service.finish(changed.run.id);
    await service.idle();
    expect(importVersionFor(service)).toBe(2);
    service.dispose();
    database.sqlite.close();
  });

  it("persists attachments on messages and exports threads with them", async () => {
    const { database, service } = await setup();
    const started = service.begin({ provider: "cherry", transport: "directory", stableSourceKey: "root", displayName: "Cherry Studio" });
    service.appendThreads(started.run.id, [thread("帮我排期")]);
    await service.finish(started.run.id);
    await service.idle();
    const stored = database.sqlite.prepare("SELECT attachments FROM external_agent_messages WHERE stable_key='m1'").get() as { attachments: string };
    expect(JSON.parse(stored.attachments)).toMatchObject([{ sourceKey: "migration:cherry:src:file:1", name: "roadmap.pdf", fileId: "file-1" }]);
    const exported = service.exportSourceThreads(started.source.id);
    expect(exported).toHaveLength(1);
    expect(exported[0]!.messages[0]!.attachments?.[0]).toMatchObject({ name: "roadmap.pdf" });
    service.dispose();
    database.sqlite.close();
  });
});
