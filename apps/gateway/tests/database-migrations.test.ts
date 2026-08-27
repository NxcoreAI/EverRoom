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
  it("repairs pre-release Context Room overview tables without losing projections", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-room-overview-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const migrationsDir = resolve("drizzle");
    const beforeUpgrade = createDatabase(databasePath, migrationsDir);
    const projection = JSON.stringify({
      overview: { text: "Preserved overview" },
      status: { text: "active" },
    });
    beforeUpgrade.sqlite.prepare(
      "INSERT INTO context_rooms (id, title, data, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("room-legacy-overview", "Legacy overview", "{}", 0, 1, 1);
    beforeUpgrade.sqlite.exec("DROP TABLE room_overviews");
    beforeUpgrade.sqlite.exec(`
      CREATE TABLE room_overviews (
        room_id text PRIMARY KEY NOT NULL,
        revision integer DEFAULT 1 NOT NULL,
        projection text NOT NULL,
        generated_at integer NOT NULL,
        updated_at integer NOT NULL,
        FOREIGN KEY (room_id) REFERENCES context_rooms(id) ON DELETE cascade
      )
    `);
    beforeUpgrade.sqlite.exec(
      "CREATE INDEX room_overviews_updated_idx ON room_overviews (updated_at)",
    );
    beforeUpgrade.sqlite.prepare(
      "INSERT INTO room_overviews (room_id, revision, projection, generated_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("room-legacy-overview", 3, projection, 10, 11);
    beforeUpgrade.sqlite.exec("ALTER TABLE room_context_corrections DROP COLUMN proposed_by_run_id");
    beforeUpgrade.sqlite.close();

    const upgraded = createDatabase(databasePath, migrationsDir);
    const overviewColumns = upgraded.sqlite.prepare("PRAGMA table_info(room_overviews)")
      .all() as Array<{ name: string; notnull: number }>;
    const correctionColumns = upgraded.sqlite.prepare("PRAGMA table_info(room_context_corrections)")
      .all() as Array<{ name: string }>;
    const overview = upgraded.sqlite.prepare(
      "SELECT revision, base_projection, projection, generated_at, updated_at FROM room_overviews WHERE room_id = ?",
    ).get("room-legacy-overview");
    const indexes = upgraded.sqlite.prepare("PRAGMA index_list(room_overviews)")
      .all() as Array<{ name: string }>;
    upgraded.sqlite.close();

    expect(overviewColumns.find(({ name }) => name === "base_projection")?.notnull).toBe(1);
    expect(correctionColumns.map(({ name }) => name)).toContain("proposed_by_run_id");
    expect(overview).toEqual({
      revision: 3,
      base_projection: projection,
      projection,
      generated_at: 10,
      updated_at: 11,
    });
    expect(indexes.map(({ name }) => name)).toContain("room_overviews_updated_idx");

    const reopened = createDatabase(databasePath, migrationsDir);
    expect(reopened.sqlite.prepare(
      "SELECT base_projection, projection FROM room_overviews WHERE room_id = ?",
    ).get("room-legacy-overview")).toEqual({
      base_projection: projection,
      projection,
    });
    reopened.sqlite.close();
  });

  it("creates the document outbox polling index", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-outbox-index-test-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));

    const indexes = database.sqlite.prepare("PRAGMA index_list(jobs)").all() as Array<{ name: string }>;
    database.sqlite.close();

    expect(indexes.map((index) => index.name)).toContain("jobs_type_status_created_idx");
  });

  it("reconciles the pre-merge Context Room migration branch", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-context-room-branch-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const migrationsDir = resolve("drizzle");
    const beforeMerge = createDatabase(databasePath, migrationsDir);
    beforeMerge.sqlite.prepare(
      "INSERT INTO room_relations (id, room_a_id, room_b_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("relation-1", "room-a", "room-b", 1, 1);
    beforeMerge.sqlite.exec("DROP TABLE clipper_assets");
    beforeMerge.sqlite.exec("DROP TABLE clipper_captures");
    beforeMerge.sqlite.exec("DROP TABLE parsed_documents");
    beforeMerge.sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?").run(1787552314033);
    const insertLegacyMigration = beforeMerge.sqlite.prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    );
    insertLegacyMigration.run("pre-merge-yjs", 1787580711823);
    insertLegacyMigration.run("pre-merge-knowledge-scoring", 1787636018104);
    insertLegacyMigration.run("pre-merge-room-relations", 1787644742114);
    beforeMerge.sqlite.close();

    const upgraded = createDatabase(databasePath, migrationsDir);
    const tables = upgraded.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const relation = upgraded.sqlite.prepare(
      "SELECT id, room_a_id, room_b_id FROM room_relations WHERE id = ?",
    ).get("relation-1");
    const journal = JSON.parse(
      await readFile(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ when: number; tag: string }> };
    const mergedEntry = journal.entries.find((entry) => entry.tag === "0030_room_relations_and_scoring");
    const mergedMarker = upgraded.sqlite.prepare(
      "SELECT created_at FROM __drizzle_migrations WHERE created_at = ?",
    ).get(mergedEntry?.when);
    upgraded.sqlite.close();

    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "parsed_documents",
      "clipper_captures",
      "clipper_assets",
      "room_relations",
    ]));
    expect(relation).toEqual({ id: "relation-1", room_a_id: "room-a", room_b_id: "room-b" });
    expect(mergedMarker).toEqual({ created_at: mergedEntry?.when });
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
    beforeMerge.sqlite.exec("ALTER TABLE ingest_events DROP COLUMN reinstated_at");
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

  it("adopts the complete pre-release connector configuration migration", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-connector-config-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const currentMigrationsDir = resolve("drizzle");
    const previousMigrationsDir = join(dataDir, "previous-migrations");
    await mkdir(join(previousMigrationsDir, "meta"), { recursive: true });

    const journal = JSON.parse(
      await readFile(join(currentMigrationsDir, "meta", "_journal.json"), "utf8"),
    ) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    const previousEntries = journal.entries.filter((entry) => entry.idx <= 15);
    await Promise.all(previousEntries.map((entry) => copyFile(
      join(currentMigrationsDir, `${entry.tag}.sql`),
      join(previousMigrationsDir, `${entry.tag}.sql`),
    )));
    await writeFile(join(previousMigrationsDir, "meta", "_journal.json"), JSON.stringify({
      ...journal,
      entries: previousEntries,
    }));

    const preRelease = createDatabase(databasePath, previousMigrationsDir);
    const connectorConfigSql = await readFile(
      join(currentMigrationsDir, "0016_dazzling_silver_samurai.sql"),
      "utf8",
    );
    preRelease.sqlite.exec(connectorConfigSql.replaceAll("--> statement-breakpoint", "\n"));
    preRelease.sqlite.prepare(
      "INSERT INTO connector_prompt_profiles "
      + "(id, service, resource_type, name, version, template, schema_version, content_hash, status, created_at, updated_at) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("gmail-email-v1", "gmail", "email", "Gmail", 1, "prompt", 1, "hash", "published", 1, 1);
    preRelease.sqlite.prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    ).run("pre-release-connector-config", 1787148973623);
    preRelease.sqlite.close();

    const upgraded = createDatabase(databasePath, currentMigrationsDir);
    expect(upgraded.sqlite.prepare(
      "SELECT id, template FROM connector_prompt_profiles WHERE id = ?",
    ).get("gmail-email-v1")).toEqual({ id: "gmail-email-v1", template: "prompt" });
    const latestMigration = upgraded.sqlite.prepare(
      "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
    ).get();
    upgraded.sqlite.close();
    expect(latestMigration).toEqual({ created_at: journal.entries.at(-1)?.when });
  });

  it("adopts the pre-release connector Markdown migrations after the main migration rebase", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-connector-markdown-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const currentMigrationsDir = resolve("drizzle");
    const previousMigrationsDir = join(dataDir, "previous-migrations");
    await mkdir(join(previousMigrationsDir, "meta"), { recursive: true });

    const journal = JSON.parse(
      await readFile(join(currentMigrationsDir, "meta", "_journal.json"), "utf8"),
    ) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    const previousEntries = journal.entries.filter((entry) => entry.idx <= 16);
    await Promise.all(previousEntries.map((entry) => copyFile(
      join(currentMigrationsDir, `${entry.tag}.sql`),
      join(previousMigrationsDir, `${entry.tag}.sql`),
    )));
    await writeFile(join(previousMigrationsDir, "meta", "_journal.json"), JSON.stringify({
      ...journal,
      entries: previousEntries,
    }));

    const preRelease = createDatabase(databasePath, previousMigrationsDir);
    const connectorMarkdownSql = await readFile(
      join(currentMigrationsDir, "0018_charming_vampiro.sql"),
      "utf8",
    );
    preRelease.sqlite.exec(connectorMarkdownSql.replaceAll("--> statement-breakpoint", "\n"));
    preRelease.sqlite.prepare(
      "INSERT INTO connector_markdown_artifacts "
      + "(id, owner_id, service, connection_name, resource_type, source_record_id, ingest_source_id, "
      + "active_path, source_content_hash, renderer_version, created_at, updated_at) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "artifact-1", "owner-1", "gmail", "connection-1", "email", "email-1", "source-1",
      "/tmp/source-1.md", "source-hash", "renderer-v1", 1, 1,
    );
    const insertLegacyMigration = preRelease.sqlite.prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    );
    insertLegacyMigration.run("pre-release-connector-markdown", 1787208981931);
    insertLegacyMigration.run("pre-release-ingest-soft-delete", 1787218751617);
    insertLegacyMigration.run("pre-release-ingest-index", 1787218949702);
    preRelease.sqlite.close();

    const upgraded = createDatabase(databasePath, currentMigrationsDir);
    expect(upgraded.sqlite.prepare(
      "SELECT id, source_record_id FROM connector_markdown_artifacts WHERE id = ?",
    ).get("artifact-1")).toEqual({ id: "artifact-1", source_record_id: "email-1" });
    const jobIndexes = upgraded.sqlite.prepare("PRAGMA index_list(jobs)").all() as Array<{ name: string }>;
    expect(jobIndexes.map(({ name }) => name)).toContain("jobs_type_status_created_idx");
    const canonicalEntries = journal.entries.filter((entry) => entry.idx >= 17);
    const placeholders = canonicalEntries.map(() => "?").join(", ");
    const adopted = upgraded.sqlite.prepare(
      `SELECT created_at FROM __drizzle_migrations WHERE created_at IN (${placeholders}) ORDER BY created_at`,
    ).all(...canonicalEntries.map(({ when }) => when));
    upgraded.sqlite.close();
    expect(adopted).toEqual(canonicalEntries.map(({ when }) => ({ created_at: when })));
  });

  it("upgrades databases from the connector migration branch", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-connector-migration-test-"));
    temporaryDirectories.push(dataDir);
    const databasePath = join(dataDir, "gateway.sqlite");
    const currentMigrationsDir = resolve("drizzle");
    const legacyMigrationsDir = join(dataDir, "legacy-migrations");
    await mkdir(join(legacyMigrationsDir, "meta"), { recursive: true });

    const sharedEntries = JSON.parse(
      await readFile(join(currentMigrationsDir, "meta", "_journal.json"), "utf8"),
    ).entries.slice(0, 10) as Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    await Promise.all(sharedEntries.map((entry) => copyFile(
      join(currentMigrationsDir, `${entry.tag}.sql`),
      join(legacyMigrationsDir, `${entry.tag}.sql`),
    )));
    await writeFile(join(legacyMigrationsDir, "meta", "_journal.json"), JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: sharedEntries,
    }));

    const legacy = createDatabase(databasePath, legacyMigrationsDir);
    const connectorSql = await readFile(join(currentMigrationsDir, "0015_low_overlord.sql"), "utf8");
    legacy.sqlite.exec(connectorSql.replaceAll("--> statement-breakpoint", "\n"));
    const insertMigration = legacy.sqlite.prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    );
    insertMigration.run("legacy-connector-0010", 1787123300145);
    insertMigration.run("legacy-connector-0011", 1787135410813);
    insertMigration.run("legacy-connector-0012", 1787136488097);
    legacy.sqlite.close();

    const upgraded = createDatabase(databasePath, currentMigrationsDir);
    const tables = upgraded.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    upgraded.sqlite.close();
    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "connector_accounts",
      "document_block_references",
      "document_operations",
      "pending_agent_intents",
      "entities",
      "room_wikis",
    ]));
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
