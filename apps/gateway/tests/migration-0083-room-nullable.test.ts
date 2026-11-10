import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";

// P0-2d 升级路径回归：0083 重建 document_operations 时不能丢四张子表的数据
// （SQLite 事务内 PRAGMA foreign_keys 是空操作，DROP TABLE 会级联清空子表）。

const temporaryDirectories: string[] = [];
const TAG = "0083_document_operations_room_nullable";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function migrationsThrough0082(dataDir: string): Promise<string> {
  const target = join(dataDir, "drizzle-0082");
  await cp(resolve("drizzle"), target, { recursive: true });
  const journalPath = join(target, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: Array<{ tag?: string }>;
  };
  // 截断到 0082：不能只删 0083 一条，否则后续迁移（如 0084）的 when 更大，
  // 会让 Drizzle 把 0083 视作已越过而静默跳过。
  const cutoff = journal.entries.findIndex((entry) => entry.tag === TAG);
  journal.entries = cutoff === -1 ? journal.entries : journal.entries.slice(0, cutoff);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  await rm(join(target, `${TAG}.sql`));
  return target;
}

describe("0083 document_operations.room_id 可空迁移", () => {
  it("保留既有操作与其子表数据，并允许工作区级操作（room_id 为 NULL）", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-migration-0083-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");

    const oldCursor = createDatabase(databasePath, await migrationsThrough0082(dataDir));
    const now = Date.now();
    oldCursor.sqlite.prepare(`
      INSERT INTO document_operations (
        id, capability_id, capability_version, interaction_mode, presenter_key, room_id,
        document_id, document_title, agent_session_id, run_id, status, revision, summary, input,
        created_at, updated_at
      ) VALUES ('op-legacy', 'document.create', 1, 'streaming_commit', 'streaming-document', 'room-1',
        NULL, '旧文档', 'session-legacy', 'run-legacy', 'running', 1, '旧操作', '{}', ?, ?)
    `).run(now, now);
    oldCursor.sqlite.prepare(`
      INSERT INTO document_operation_items (
        id, operation_id, sequence, operation, before_json, after_json, markdown,
        content_hash, status, created_at, updated_at
      ) VALUES ('item-legacy', 'op-legacy', 1, 'stream_chunk', 'null', 'null', '正文',
        'hash-legacy', 'pending', ?, ?)
    `).run(now, now);
    oldCursor.sqlite.prepare(`
      INSERT INTO document_operation_events (id, operation_id, revision, type, payload, created_at)
      VALUES ('event-legacy', 'op-legacy', 1, 'stream.begin', '{}', ?)
    `).run(now);
    oldCursor.sqlite.close();

    // 走真实升级路径：同一个库文件、完整迁移目录（含 0083）。
    const upgraded = createDatabase(databasePath, resolve("drizzle"));
    try {
      const notNull = (upgraded.sqlite.pragma("table_info(document_operations)") as Array<{ name: string; notnull: number }>)
        .find((column) => column.name === "room_id")?.notnull;
      expect(notNull).toBe(0);
      expect(upgraded.sqlite.prepare("SELECT id, room_id FROM document_operations WHERE id = 'op-legacy'").get())
        .toEqual({ id: "op-legacy", room_id: "room-1" });
      // 子表数据必须原样保留（曾被 DROP TABLE 级联清空）。
      expect(upgraded.sqlite.prepare("SELECT count(*) AS count FROM document_operation_items").get())
        .toEqual({ count: 1 });
      expect(upgraded.sqlite.prepare("SELECT count(*) AS count FROM document_operation_events").get())
        .toEqual({ count: 1 });
      // 工作区级操作可写入。
      upgraded.sqlite.prepare(`
        INSERT INTO document_operations (
          id, capability_id, capability_version, interaction_mode, presenter_key, room_id,
          document_id, document_title, agent_session_id, run_id, status, revision, summary, input,
          created_at, updated_at
        ) VALUES ('op-workspace', 'document.create', 1, 'streaming_commit', 'streaming-document', NULL,
          NULL, '工作区文档', 'session-ws', 'run-ws', 'running', 1, '工作区操作', '{}', ?, ?)
      `).run(now, now);
      expect(upgraded.sqlite.prepare("SELECT room_id FROM document_operations WHERE id = 'op-workspace'").get())
        .toEqual({ room_id: null });
      // 外键仍然生效。
      expect(() => upgraded.sqlite.prepare(`
        INSERT INTO document_operation_items (
          id, operation_id, sequence, operation, before_json, after_json, markdown,
          content_hash, status, created_at, updated_at
        ) VALUES ('item-orphan', 'op-missing', 1, 'stream_chunk', 'null', 'null', 'x',
          'hash-orphan', 'pending', ?, ?)
      `).run(now, now)).toThrow();
    } finally {
      upgraded.sqlite.close();
    }
  });
});
