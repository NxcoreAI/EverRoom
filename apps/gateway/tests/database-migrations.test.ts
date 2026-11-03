import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  it("creates the document outbox polling index", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-outbox-index-test-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));

    const indexes = database.sqlite.prepare("PRAGMA index_list(jobs)").all() as Array<{ name: string }>;
    database.sqlite.close();

    expect(indexes.map((index) => index.name)).toContain("jobs_type_status_created_idx");
  });

  it("reconciles the pre-merge Yjs migration branch with the canonical schema", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-yjs-branch-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const migrationsDir = resolve("drizzle");
    const beforeMerge = createDatabase(databasePath, migrationsDir);
    const now = Date.now();
    const content = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "preserved" }] }],
    });
    beforeMerge.sqlite.prepare(
      "INSERT INTO documents (id, title, content_json, version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("document-1", "Preserved", content, 1, "active", now, now);
    beforeMerge.sqlite.prepare(
      "INSERT INTO doc_versions (id, document_id, version, title, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("version-1", "document-1", 1, "Preserved", content, now);

    beforeMerge.sqlite.exec("DROP TABLE runtime_config_store");
    beforeMerge.sqlite.exec("DROP TABLE agent_schedules");
    beforeMerge.sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?").run(1787320000000);
    beforeMerge.sqlite.prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    ).run("pre-merge-yjs-history", 1787577820465);
    beforeMerge.sqlite.close();

    const upgraded = createDatabase(databasePath, migrationsDir);
    const tables = upgraded.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const ingestColumns = upgraded.sqlite.prepare("PRAGMA table_info(ingest_events)")
      .all() as Array<{ name: string }>;
    const preserved = upgraded.sqlite.prepare(
      "SELECT title, content_json FROM doc_versions WHERE id = ?",
    ).get("version-1");
    upgraded.sqlite.close();

    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "runtime_config_store",
      "agent_schedules",
      "document_yjs_checkpoints",
      "document_yjs_updates",
      "document_yjs_versions",
    ]));
    expect(ingestColumns.map(({ name }) => name)).toContain("reinstated_at");
    expect(preserved).toEqual({ title: "Preserved", content_json: content });
  });

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
      "document_yjs_checkpoints",
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
    // Phase 2i：migration 0085 已删掉全部 Room 表，升级后不应再存在。
    expect(upgraded.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('context_rooms', 'room_doc_links')",
    ).all()).toEqual([]);
    expect(upgraded.sqlite.prepare("SELECT id, room_id FROM agent_sessions").all()).toEqual([
      { id: "session-1", room_id: "room-1" },
    ]);
    upgraded.sqlite.close();
  });

  it("drops sync-era connector tables and keeps only tombstones", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-connector-migration-test-"));
    temporaryDirectories.push(dataDir);
    const db = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const tables = (db.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'connector%'",
    ).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(tables).toContain("connector_tombstones");
    for (const dropped of [
      "connector_accounts",
      "connector_emails",
      "connector_records",
      "connector_documents",
      "connector_calendar_events",
      "connector_sync_jobs",
      "connector_markdown_artifacts",
      "connector_format_mappings",
    ]) {
      expect(tables).not.toContain(dropped);
    }
    db.sqlite.close();
  });

  it("repairs databases that ran the EverRoom dev branch before this branch (mixed history)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-mixed-dev-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const migrationsDir = resolve("drizzle");

    // 先得到一个正常迁移完的库，再把它改造成「跑过 dev 分支」的混合状态：
    // dev 的 0083_slides_generation_checkpoints（时间戳 1792771200000）被应用过，
    // 而本分支的 0083–0087（时间戳更早）被游标跳过，0092 也尚未记录。
    const seeded = createDatabase(databasePath, migrationsDir);
    seeded.sqlite.prepare(
      "INSERT INTO slides_generation_checkpoints (key, state, updated_at) VALUES ('kept', '{\"batches\":{}}', 1)",
    ).run();
    seeded.sqlite.exec("PRAGMA foreign_keys = OFF");
    const columns = seeded.sqlite.prepare("PRAGMA table_info(document_operations)").all() as Array<{
      name: string; type: string; notnull: number; pk: number;
    }>;
    const definitions = columns.map((column) => {
      const notNull = column.name === "room_id" ? 1 : column.notnull;
      return `\`${column.name}\` ${column.type}${notNull ? " NOT NULL" : ""}${column.pk ? " PRIMARY KEY" : ""}`;
    });
    seeded.sqlite.exec("DROP TABLE document_operations");
    seeded.sqlite.exec(`CREATE TABLE document_operations (${definitions.join(", ")})`);
    seeded.sqlite.exec("CREATE TABLE IF NOT EXISTS context_rooms (id text PRIMARY KEY NOT NULL)");
    seeded.sqlite.exec("DROP INDEX IF EXISTS file_entries_deleted_updated_idx");
    seeded.sqlite.exec("PRAGMA foreign_keys = ON");
    const skipWhens = [1792742457265, 1792746787000, 1792747500000, 1792748200000, 1792749000000, 1793500000000];
    for (const when of skipWhens) {
      seeded.sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(when);
    }
    // dev 的 0083 与本分支 0092 是同一份 SQL，只是编号/时间戳不同。
    const checkpointsSql = await readFile(join(migrationsDir, "0092_slides_generation_checkpoints.sql"), "utf8");
    seeded.sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
      createHash("sha256").update(checkpointsSql).digest("hex"),
      1792771200000,
    );
    seeded.sqlite.close();

    // 第二次打开：修复逻辑应补跑被跳过的 0083–0087、把 0092 记为已应用。
    const repaired = createDatabase(databasePath, migrationsDir);
    const roomId = (repaired.sqlite.prepare("PRAGMA table_info(document_operations)").all() as Array<{
      name: string; notnull: number;
    }>).find((column) => column.name === "room_id");
    const indexNames = (repaired.sqlite.prepare("PRAGMA index_list(file_entries)").all() as Array<{ name: string }>)
      .map((index) => index.name);
    const contextRooms = repaired.sqlite.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_rooms' LIMIT 1",
    ).get();
    const recorded = (when: number) => Boolean(repaired.sqlite.prepare(
      "SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1",
    ).get(when));
    const keptRow = repaired.sqlite.prepare(
      "SELECT state FROM slides_generation_checkpoints WHERE key = 'kept'",
    ).get() as { state: string } | undefined;

    expect(roomId?.notnull).toBe(0);
    expect(indexNames).toContain("file_entries_deleted_updated_idx");
    expect(contextRooms).toBeUndefined();
    for (const when of skipWhens) expect(recorded(when)).toBe(true);
    expect(keptRow?.state).toBe('{"batches":{}}');
    repaired.sqlite.close();
  });

  it("migrates Room-scoped thesis format cards into the default workspace", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-thesis-card-workspace-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const migrationsDir = resolve("drizzle");
    const workspaceMigrationWhen = 1793650000000;

    // 退回到 0093 之前：格式卡还是 room_id 维度（0080 的表形），并补一条真实卡片。
    const seeded = createDatabase(databasePath, migrationsDir);
    const now = Date.now();
    seeded.sqlite.exec("DROP INDEX thesis_format_cards_workspace_source_idx");
    seeded.sqlite.exec("ALTER TABLE thesis_format_cards RENAME TO thesis_format_cards_workspace_new");
    seeded.sqlite.exec(`CREATE TABLE thesis_format_cards (
      id text PRIMARY KEY NOT NULL,
      room_id text NOT NULL,
      format_card text NOT NULL,
      source_file_entry_id text,
      source_name text DEFAULT '' NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )`);
    seeded.sqlite.exec("CREATE UNIQUE INDEX thesis_format_cards_room_source_idx ON thesis_format_cards (room_id, source_name)");
    seeded.sqlite.exec("DROP TABLE thesis_format_cards_workspace_new");
    // 把游标退回到 0094 之前：0094 之后的迁移记录也要一并删掉，否则游标停在后
    // 面的迁移上，0094 会被当成历史跳过。
    seeded.sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?").run(workspaceMigrationWhen);
    seeded.sqlite.prepare(
      "INSERT INTO thesis_format_cards (id, room_id, format_card, source_file_entry_id, source_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("card-legacy", "room-1", "{\"page\":{}}", null, "模版.docx", now, now);
    seeded.sqlite.close();

    const migrated = createDatabase(databasePath, migrationsDir);
    const columns = (migrated.sqlite.prepare("PRAGMA table_info(thesis_format_cards)").all() as Array<{
      name: string;
    }>).map(({ name }) => name);
    const card = migrated.sqlite.prepare(
      "SELECT workspace_id, source_name FROM thesis_format_cards WHERE id = 'card-legacy'",
    ).get() as { workspace_id: string; source_name: string } | undefined;
    const recorded = Boolean(migrated.sqlite.prepare(
      "SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1",
    ).get(workspaceMigrationWhen));

    // Room 与工作区没有可推断的对应关系：存量卡统一归默认工作区，且不丢卡。
    expect(columns).toContain("workspace_id");
    expect(columns).not.toContain("room_id");
    expect(card).toEqual({ workspace_id: "default", source_name: "模版.docx" });
    expect(recorded).toBe(true);
    migrated.sqlite.close();
  });

  it("records 0094 when cards are already workspace-shaped (local preview builds)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-thesis-cards-applied-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const migrationsDir = resolve("drizzle");
    const workspaceMigrationWhen = 1793650000000;

    const seeded = createDatabase(databasePath, migrationsDir);
    const now = Date.now();
    seeded.sqlite.prepare(
      "INSERT INTO thesis_format_cards (id, workspace_id, format_card, source_file_entry_id, source_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("card-1", "default", "{}", null, "模版.docx", now, now);
    // 模拟本地预览构建：表已经是 workspace 形态，但迁移记录里没有 0094。
    seeded.sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(workspaceMigrationWhen);
    seeded.sqlite.close();

    // 没有兼容补记时，Drizzle 会重放 0094（RENAME 后按 room_id 复制）直接失败。
    const reopened = createDatabase(databasePath, migrationsDir);
    const recorded = Boolean(reopened.sqlite.prepare(
      "SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1",
    ).get(workspaceMigrationWhen));
    const card = reopened.sqlite.prepare(
      "SELECT workspace_id FROM thesis_format_cards WHERE id = 'card-1'",
    ).get() as { workspace_id: string } | undefined;

    expect(recorded).toBe(true);
    expect(card?.workspace_id).toBe("default");
    reopened.sqlite.close();
  });

  it("repairs local-folder updated_at bumped by startup rescans", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-local-folder-updated-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const migrationsDir = resolve("drizzle");
    const repairWhen = 1793700000000;

    // 本地夹条目入库于 9 月、文件本身也是 9 月改的，但上一次启动重扫把
    // updated_at 刷成了「现在」——资料库按最近更新取 200 条时它就会长期压过
    // 用户自己上传的文件。
    const seeded = createDatabase(databasePath, migrationsDir);
    const createdAt = 1790000000000;
    const fileMtime = 1790100000000;
    const scanTime = Date.now();
    seeded.sqlite.prepare(
      "INSERT INTO file_entries (id, source_kind, source_key, original_name, extension, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("file-local", "local-folder", "local:s:i", "README.md", ".md", "ready", createdAt, scanTime);
    seeded.sqlite.prepare(
      "INSERT INTO file_blobs (content_hash, storage_path, byte_size, mime, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("a".repeat(64), `sha256/${"a".repeat(64)}`, 1, "text/markdown", createdAt);
    seeded.sqlite.prepare(
      "INSERT INTO file_versions (id, file_entry_id, version_no, content_hash, source_modified_at, parser_id, parser_version, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("fver-local", "file-local", 1, "a".repeat(64), fileMtime, "markdown@1", 1, "parsed", createdAt);
    seeded.sqlite.prepare("UPDATE file_entries SET current_version_id = 'fver-local' WHERE id = 'file-local'").run();
    seeded.sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(repairWhen);
    seeded.sqlite.close();

    const migrated = createDatabase(databasePath, migrationsDir);
    const row = migrated.sqlite.prepare(
      "SELECT updated_at FROM file_entries WHERE id = 'file-local'",
    ).get() as { updated_at: number } | undefined;
    const recorded = Boolean(migrated.sqlite.prepare(
      "SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1",
    ).get(repairWhen));

    // 归位到文件自身的最后修改时间，而不是重扫时间。
    expect(row?.updated_at).toBe(fileMtime);
    expect(recorded).toBe(true);
    migrated.sqlite.close();
  });

  it("repairs dev-branch databases whose cursor jumped over 0088–0091", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-skipped-workspace-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const migrationsDir = resolve("drizzle");
    const migrationWhens = [1793150000000, 1793274371822, 1793339200000, 1793420000000, 1793500000000];

    // 造出「只跑过 dev、从未跑过本分支 0088–0091」的库：这四支的 schema 效果
    // 全部撤掉，迁移记录停在 dev 的 slides 时间戳（1792771200000）。再次启动时
    // 混合历史修复会为了复用 dev 建好的 slides 表，在 migrate 之前把 0092 记为
    // 已应用——这一步会把游标推过 0088–0091，使它们被永久跳过。
    const seeded = createDatabase(databasePath, migrationsDir);
    const now = Date.now();
    seeded.sqlite.prepare(
      "INSERT INTO file_entries (id, source_kind, source_key, original_name, extension, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("file-1", "manual-upload", "manual:file-1", "notes.txt", "txt", "ready", now, now);
    seeded.sqlite.prepare(
      "INSERT INTO slides_generation_checkpoints (key, state, updated_at) VALUES ('kept', '{}', 1)",
    ).run();
    for (const when of migrationWhens) {
      seeded.sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(when);
    }
    seeded.sqlite.exec("DROP TABLE connector_tombstones");
    seeded.sqlite.exec("DROP TABLE agent_workspaces");
    seeded.sqlite.exec("DROP INDEX file_entries_workspace_idx");
    seeded.sqlite.exec("ALTER TABLE file_entries DROP COLUMN workspace_id");
    seeded.sqlite.exec("DROP INDEX agent_sessions_workspace_idx");
    seeded.sqlite.exec("ALTER TABLE agent_sessions DROP COLUMN workspace_id");
    // dev 分支没跑 0088：同步时代的连接器表还在。
    seeded.sqlite.exec("CREATE TABLE connector_accounts (id text PRIMARY KEY NOT NULL)");
    seeded.sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
      "dev-slides-0083",
      1792771200000,
    );
    seeded.sqlite.close();

    const repaired = createDatabase(databasePath, migrationsDir);
    const columnNames = (table: string) => (repaired.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>).map(({ name }) => name);
    const tableExists = (table: string) => Boolean(repaired.sqlite.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    ).get(table));
    const recorded = (when: number) => Boolean(repaired.sqlite.prepare(
      "SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1",
    ).get(when));
    const fileEntry = repaired.sqlite.prepare(
      "SELECT workspace_id FROM file_entries WHERE id = 'file-1'",
    ).get() as { workspace_id: string | null } | undefined;
    const defaultWorkspace = repaired.sqlite.prepare(
      "SELECT kind FROM agent_workspaces WHERE id = 'default'",
    ).get() as { kind: string } | undefined;

    expect(columnNames("file_entries")).toContain("workspace_id");
    expect(columnNames("agent_sessions")).toContain("workspace_id");
    expect(defaultWorkspace).toEqual({ kind: "default" });
    expect(tableExists("connector_tombstones")).toBe(true);
    expect(tableExists("connector_accounts")).toBe(false);
    expect(fileEntry?.workspace_id).toBe("default");
    for (const when of migrationWhens) expect(recorded(when)).toBe(true);
    repaired.sqlite.close();
  });
});
