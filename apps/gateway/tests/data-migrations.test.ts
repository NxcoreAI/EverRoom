import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { DataMigrationService } from "../src/modules/data-migrations/service.js";

const dirs: string[] = [];
const migrationsDir = join(import.meta.dirname, "../drizzle");

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "everroom-migrations-")); dirs.push(directory);
  const database = createDatabase(join(directory, "gateway.sqlite"), migrationsDir);
  const memory = {
    enabled: true,
    replaceConversationBatches: vi.fn(async (input) => ({ sessionId: input.sessionId, messagesImported: input.messages.length })),
    deleteConversations: vi.fn(async () => ({ deletedCount: 1 })),
    searchConversations: vi.fn(async () => ({ messages: [{ id: "memory", role: "user", content: "older matching context", timestamp: new Date(0).toISOString(), sessionId: null, sourceKind: null, score: 1 }] })),
  } as any;
  return { database, memory, service: new DataMigrationService(database.db, database.sqlite, memory) };
}

afterEach(async () => { await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("data migrations", () => {
  it("upserts visible external messages, indexes search and marks missing threads unavailable", async () => {
    const { database, memory, service } = await setup();
    const first = service.begin({ provider: "openclaw", transport: "local-jsonl", stableSourceKey: "fixture", displayName: "OpenClaw" });
    service.updateProgress(first.run.id, { threadsTotal: 2, messagesTotal: 3 });
    service.appendThreads(first.run.id, [
      { stableKey: "agent-a:s1", agentId: "agent-a", externalSessionId: "s1", title: "Launch notes", messages: [
        { stableKey: "1", role: "user", content: "Plan the launch", occurredAt: "2026-01-01T00:00:00.000Z" },
        { stableKey: "2", role: "assistant", content: "Here is the plan", occurredAt: "2026-01-01T00:00:01.000Z" },
      ] },
      { stableKey: "agent-a:s2", agentId: "agent-a", externalSessionId: "s2", title: "Other", messages: [
        { stableKey: "3", role: "user", content: "Unrelated", occurredAt: "2026-01-02T00:00:00.000Z" },
      ] },
    ]);
    await service.finish(first.run.id);
    expect(service.searchConversations("launch", undefined, 20).items[0]).toMatchObject({ title: "Launch notes", messageCount: 2 });
    expect(memory.replaceConversationBatches).toHaveBeenCalledTimes(2);

    const second = service.begin({ provider: "openclaw", transport: "local-jsonl", stableSourceKey: "fixture", displayName: "OpenClaw" });
    service.appendThreads(second.run.id, [{ stableKey: "agent-a:s1", agentId: "agent-a", externalSessionId: "s1", title: "Launch notes", messages: [
      { stableKey: "1", role: "user", content: "Plan the launch today", occurredAt: "2026-01-01T00:00:00.000Z" },
      { stableKey: "2", role: "assistant", content: "Here is the plan", occurredAt: "2026-01-01T00:00:01.000Z" },
    ] }]);
    await service.finish(second.run.id);
    expect(service.searchConversations("", undefined, 20).items).toHaveLength(1);
    expect(database.sqlite.prepare("SELECT count(*) count FROM external_agent_messages").get()).toEqual({ count: 3 });
    database.sqlite.close();
  });

  it("binds only once and never copies external history into native messages", async () => {
    const { database, service } = await setup();
    database.sqlite.prepare("INSERT INTO agent_sessions(id,room_id,page_label,runtime_id,active_agent_id,status,created_at,updated_at) VALUES('native',NULL,'Agent','fake','main','idle',1,1)").run();
    const started = service.begin({ provider: "openclaw", transport: "directory", stableSourceKey: "x", displayName: "OpenClaw" });
    service.appendThreads(started.run.id, [{ stableKey: "a:s", externalSessionId: "s", title: "Imported title", messages: [
      { stableKey: "m", role: "user", content: "historic secret", occurredAt: "2026-01-01T00:00:00.000Z" },
    ] }]);
    await service.finish(started.run.id);
    const thread = service.searchConversations("historic", undefined, 10).items[0]!;
    const context = await service.bindAndBuildContext("native", thread.id, "secret");
    expect(context).toContain("untrusted reference history");
    expect(context).toContain("historic secret");
    expect(await service.bindAndBuildContext("native", thread.id, "secret")).toBeNull();
    expect(database.sqlite.prepare("SELECT count(*) count FROM agent_messages").get()).toEqual({ count: 0 });
    database.sqlite.close();
  });

  it("indexes Codex history and exposes its native thread only to the matching local provider", async () => {
    const { database, service } = await setup();
    const started = service.begin({ provider: "codex", transport: "local-jsonl", stableSourceKey: "codex-home", displayName: "Codex" });
    service.appendThreads(started.run.id, [{
      stableKey: "thread-native",
      agentId: "codex:/usr/local/bin/codex",
      externalSessionId: "thread-native",
      title: "Imported Codex task",
      messages: [
        { stableKey: "u1", role: "user", content: "Continue the importer", occurredAt: "2026-01-03T00:00:00.000Z" },
        { stableKey: "a1", role: "assistant", content: "Importer started", occurredAt: "2026-01-03T00:00:01.000Z" },
      ],
    }]);
    await service.finish(started.run.id);

    const thread = service.searchConversations("importer", undefined, 10).items[0]!;
    expect(thread).toMatchObject({ provider: "codex", externalSessionId: "thread-native" });
    expect(service.resolveNativeContinuation(thread.id, "codex:/usr/local/bin/codex")).toBe("thread-native");
    expect(service.resolveNativeContinuation(thread.id, "claude:/usr/local/bin/claude")).toBeNull();
    expect(service.resolveNativeContinuation(thread.id, "codex:/different/path")).toBeNull();
    database.sqlite.close();
  });
});
