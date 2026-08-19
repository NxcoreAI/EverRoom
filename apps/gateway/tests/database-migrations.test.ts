import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("database migrations", () => {
  it("upgrades databases that applied the legacy reality 0002 migration", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const currentMigrationsDir = resolve("drizzle");
    const legacyMigrationsDir = join(dataDir, "legacy-migrations");
    await mkdir(join(legacyMigrationsDir, "meta"), { recursive: true });

    await Promise.all([
      copyFile(join(currentMigrationsDir, "0000_lush_maverick.sql"), join(legacyMigrationsDir, "0000_lush_maverick.sql")),
      copyFile(join(currentMigrationsDir, "0001_motionless_captain_marvel.sql"), join(legacyMigrationsDir, "0001_motionless_captain_marvel.sql")),
      copyFile(join(currentMigrationsDir, "0003_opposite_beast.sql"), join(legacyMigrationsDir, "0002_broken_clint_barton.sql")),
      writeFile(join(legacyMigrationsDir, "meta", "_journal.json"), JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [
          { idx: 0, version: "6", when: 1786714543323, tag: "0000_lush_maverick", breakpoints: true },
          { idx: 1, version: "6", when: 1786721919374, tag: "0001_motionless_captain_marvel", breakpoints: true },
          { idx: 2, version: "6", when: 1786780256138, tag: "0002_broken_clint_barton", breakpoints: true },
        ],
      })),
    ]);

    createDatabase(databasePath, legacyMigrationsDir).sqlite.close();

    const upgraded = createDatabase(databasePath, currentMigrationsDir);
    const tables = upgraded.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const blockColumns = upgraded.sqlite.prepare("PRAGMA table_info(document_blocks)")
      .all() as Array<{ name: string }>;
    const documentColumns = upgraded.sqlite.prepare("PRAGMA table_info(documents)")
      .all() as Array<{ name: string }>;
    const versionColumns = upgraded.sqlite.prepare("PRAGMA table_info(doc_versions)")
      .all() as Array<{ name: string }>;
    upgraded.sqlite.close();

    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "documents",
      "document_blocks",
      "document_block_references",
      "document_operations",
      "document_operation_items",
      "document_operation_commands",
      "document_operation_events",
      "pending_agent_intents",
      "reality_events",
    ]));
    for (const removedTable of [
      "document_patches",
      "document_patch_hunks",
      "doc_transactions",
      "doc_ops",
    ]) {
      expect(tables.map(({ name }) => name)).not.toContain(removedTable);
    }
    expect(blockColumns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "document_id",
      "block_id",
      "root_block_id",
      "sibling_index",
      "depth",
      "indexed_version",
    ]));
    expect(blockColumns.map(({ name }) => name)).not.toContain("id");
    expect(documentColumns.map(({ name }) => name)).toContain("content_schema_version");
    expect(versionColumns.map(({ name }) => name)).toContain("title");
  });

  it("clears the document domain at cutover while preserving Rooms and Agent sessions", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-block-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const currentMigrationsDir = resolve("drizzle");
    const legacyMigrationsDir = join(dataDir, "legacy-migrations");
    await mkdir(join(legacyMigrationsDir, "meta"), { recursive: true });
    const journal = JSON.parse(await readFile(join(currentMigrationsDir, "meta", "_journal.json"), "utf8")) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    const legacyEntries = journal.entries.filter((entry) => entry.idx <= 12);
    await Promise.all(legacyEntries.map((entry) => copyFile(
      join(currentMigrationsDir, `${entry.tag}.sql`),
      join(legacyMigrationsDir, `${entry.tag}.sql`),
    )));
    await writeFile(join(legacyMigrationsDir, "meta", "_journal.json"), JSON.stringify({
      ...journal,
      entries: legacyEntries,
    }));

    const canonical = {
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { id: "preserved-block" },
        content: [{ type: "text", text: "canonical content" }],
      }],
    };
    const legacy = createDatabase(databasePath, legacyMigrationsDir);
    const now = Date.now();
    legacy.sqlite.prepare(
      "INSERT INTO context_rooms (id, title, kind, data, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("room-1", "Preserved Room", "workspace", "{}", 0, now, now);
    legacy.sqlite.prepare(
      "INSERT INTO agent_sessions (id, room_id, page_label, runtime_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("session-1", "room-1", "rooms", "test", "idle", now, now);
    legacy.sqlite.prepare(
      "INSERT INTO agent_runs (id, session_id, idempotency_key, status, prompt, last_event_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("run-1", "session-1", "run-key", "completed", "prompt", 0, now);
    legacy.sqlite.prepare(
      "INSERT INTO documents (id, title, content_json, version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("doc-migrated", "Migrated", JSON.stringify(canonical), 1, "active", now, now);
    legacy.sqlite.prepare(
      "INSERT INTO room_doc_links (room_id, document_id, linked_at) VALUES (?, ?, ?)",
    ).run("room-1", "doc-migrated", now);
    legacy.sqlite.prepare(
      "INSERT INTO doc_versions (id, document_id, version, title, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("version-1", "doc-migrated", 1, "Migrated", JSON.stringify(canonical), now);
    legacy.sqlite.prepare(
      "INSERT INTO document_blocks (document_id, block_id, parent_block_id, root_block_id, type, sibling_index, ordinal, path, depth, text_preview, indexed_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("doc-migrated", "stale-block", null, "stale-block", "paragraph", 0, 0, "[0]", 0, "stale", 1);
    legacy.sqlite.prepare(
      "INSERT INTO document_operations (id, capability_id, capability_version, interaction_mode, presenter_key, room_id, document_id, document_title, agent_session_id, run_id, base_version, status, revision, summary, input, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("operation-1", "document.edit", 1, "atomic_review", "atomic-diff", "room-1", "doc-migrated", "Migrated", "session-1", "run-1", 1, "awaiting_review", 1, "Review", "{}", now, now);
    legacy.sqlite.prepare(
      "INSERT INTO pending_agent_intents (id, session_id, source_run_id, original_prompt, target_capability, allowed_room_ids, allowed_document_ids, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("intent-1", "session-1", "run-1", "Edit", "document.edit", '["room-1"]', '["doc-migrated"]', now + 60_000, now);
    legacy.sqlite.close();

    const upgraded = createDatabase(databasePath, currentMigrationsDir);
    expect(upgraded.sqlite.prepare("SELECT * FROM documents").all()).toEqual([]);
    expect(upgraded.sqlite.prepare("SELECT * FROM doc_versions").all()).toEqual([]);
    expect(upgraded.sqlite.prepare("SELECT * FROM document_blocks").all()).toEqual([]);
    expect(upgraded.sqlite.prepare("SELECT * FROM document_operations").all()).toEqual([]);
    expect(upgraded.sqlite.prepare("SELECT * FROM pending_agent_intents").all()).toEqual([]);
    expect(upgraded.sqlite.prepare("SELECT id, title FROM context_rooms").all()).toEqual([
      { id: "room-1", title: "Preserved Room" },
    ]);
    expect(upgraded.sqlite.prepare("SELECT id, room_id FROM agent_sessions").all()).toEqual([
      { id: "session-1", room_id: "room-1" },
    ]);
    upgraded.sqlite.close();
  });
});
