import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { repairContextRoomSchema } from "./context-room-compatibility.js";

export interface DatabaseClient {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database.Database;
}

interface MigrationJournalEntry {
  tag?: string;
  when?: number;
}

function readMigrationJournal(migrationsDir: string): MigrationJournalEntry[] {
  try {
    const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
      entries?: MigrationJournalEntry[];
    };
    return journal.entries ?? [];
  } catch {
    return [];
  }
}

function recordMigration(
  sqlite: Database.Database,
  migrationsDir: string,
  entry: MigrationJournalEntry,
): void {
  if (!entry.tag || typeof entry.when !== "number") return;
  if (sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1").get(entry.when)) return;
  const migrationSql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
  sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
    .run(createHash("sha256").update(migrationSql).digest("hex"), entry.when);
}

function runAdditiveMigrationIdempotently(
  sqlite: Database.Database,
  migrationsDir: string,
  tag: string,
): void {
  const migrationPath = join(migrationsDir, `${tag}.sql`);
  if (!existsSync(migrationPath)) return;
  const hasObject = (type: "table" | "index", name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
  ).get(type, name));
  const hasColumn = (table: string, column: string) => hasObject("table", table) && new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  ).has(column);

  const sql = readFileSync(migrationPath, "utf8");
  for (const statement of sql.split(/--> statement-breakpoint/g).map((item) => item.trim()).filter(Boolean)) {
    const createTable = statement.match(/^CREATE TABLE(?: IF NOT EXISTS)? [`"]([^`"]+)[`"]/)?.[1];
    if (createTable && hasObject("table", createTable)) continue;
    const createIndex = statement.match(/^CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)? [`"]([^`"]+)[`"]/)?.[1];
    if (createIndex && hasObject("index", createIndex)) continue;
    const addColumn = statement.match(/^ALTER TABLE [`"]([^`"]+)[`"] ADD [`"]([^`"]+)[`"]+/);
    if (addColumn && (!hasObject("table", addColumn[1]!) || hasColumn(addColumn[1]!, addColumn[2]!))) continue;
    sqlite.exec(statement);
  }
}

/**
 * The connector branch shipped migrations 0010-0012 with later timestamps than
 * the main branch's document migrations. On an upgraded install Drizzle would
 * therefore skip the document/knowledge migrations and only retry 0015. Move
 * that legacy cursor back to the shared 0009 baseline so the canonical chain
 * can run once; the 0015 connector migration is idempotent for its old tables.
 */
function repairLegacyMigrationCursor(sqlite: Database.Database, migrationsDir: string): void {
  const hasTable = (name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
  if (!hasTable("__drizzle_migrations") || !hasTable("connector_accounts") || hasTable("document_block_references")) {
    return;
  }

  const entry = readMigrationJournal(migrationsDir).find((item) => item.tag === "0010_tricky_mongoose");
  const canonicalFirstMigrationAt = typeof entry?.when === "number" ? entry.when : null;
  if (canonicalFirstMigrationAt === null) return;

  const hasLegacyCursor = sqlite.prepare(
    "SELECT 1 FROM __drizzle_migrations WHERE created_at >= ? LIMIT 1",
  ).get(canonicalFirstMigrationAt);
  if (!hasLegacyCursor) return;
  sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?").run(canonicalFirstMigrationAt);
}

/**
 * Development builds briefly shipped the connector configuration schema as
 * 0013 before it was rebased onto the canonical migration chain as 0016. If
 * that complete schema is already present, adopt it instead of replaying the
 * same CREATE TABLE / ALTER TABLE statements and losing the existing data.
 */
function adoptPreReleaseConnectorConfigMigration(sqlite: Database.Database, migrationsDir: string): void {
  const hasTable = (name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
  if (!hasTable("__drizzle_migrations")) return;

  const entries = readMigrationJournal(migrationsDir);
  const previous = entries.find((item) => item.tag === "0015_low_overlord");
  const canonical = entries.find((item) => item.tag === "0016_dazzling_silver_samurai");
  if (typeof previous?.when !== "number" || typeof canonical?.when !== "number") return;

  const latest = sqlite.prepare(
    "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  ).get() as { created_at?: number } | undefined;
  if (typeof latest?.created_at !== "number"
    || latest.created_at < previous.when
    || latest.created_at >= canonical.when) return;

  for (const table of [
    "connector_prompt_profiles",
    "connector_sync_job_states",
    "connector_sync_job_versions",
  ]) {
    if (!hasTable(table)) return;
  }

  const hasColumns = (table: string, expected: string[]) => {
    if (!hasTable(table)) return false;
    const columns = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name));
    return expected.every((name) => columns.has(name));
  };
  if (!hasColumns("connector_accounts", ["display_name", "account_label", "credential_ref"])) return;
  if (!hasColumns("connector_sync_jobs", [
    "name", "prompt_profile_id", "prompt_override", "schedule_type", "timezone",
    "retry_policy", "priority", "status", "config_version",
  ])) return;
  if (!hasColumns("connector_sync_runs", [
    "job_version_id", "unchanged", "quarantined", "rendered_prompt_hash",
    "prompt_profile_version", "input_checkpoint", "output_checkpoint",
  ])) return;

  const migrationSql = readFileSync(join(migrationsDir, `${canonical.tag}.sql`), "utf8");
  const hash = createHash("sha256").update(migrationSql).digest("hex");
  sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
    .run(hash, canonical.when);
}

/**
 * The connector Markdown work briefly shipped as migrations 0017-0019 before
 * main claimed 0017. Those builds already have the complete schema, but their
 * later timestamps make Drizzle skip main's 0017 and replay canonical 0018.
 * Adopt both canonical migrations after verifying every legacy schema object.
 */
function adoptPreReleaseConnectorMarkdownMigrations(
  sqlite: Database.Database,
  migrationsDir: string,
): void {
  const hasObject = (type: "table" | "index", name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
  ).get(type, name));
  if (!hasObject("table", "__drizzle_migrations")) return;

  const hasColumns = (table: string, expected: string[]) => {
    if (!hasObject("table", table)) return false;
    const columns = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name));
    return expected.every((name) => columns.has(name));
  };
  if (!hasColumns("connector_markdown_artifacts", [
    "id", "owner_id", "service", "connection_name", "resource_type", "source_record_id",
    "ingest_source_id", "active_path", "source_content_hash", "markdown_content_hash",
    "renderer_version", "version", "status", "ingest_status", "last_error", "parsed_id",
    "ingest_event_id", "created_at", "updated_at", "deleted_at",
  ])) return;
  if (!hasColumns("connector_markdown_outbox", [
    "id", "owner_id", "resource_type", "ingest_source_id", "operation", "source_content_hash",
    "status", "attempts", "available_at", "lease_owner", "lease_until", "last_error",
    "created_at", "updated_at",
  ])) return;
  if (!hasColumns("ingest_events", ["deleted_at"])) return;
  for (const index of [
    "connector_markdown_artifacts_source_idx",
    "connector_markdown_artifacts_ingest_source_idx",
    "connector_markdown_artifacts_status_idx",
    "connector_markdown_outbox_due_idx",
    "connector_markdown_outbox_source_idx",
    "ingest_events_source_hash_idx",
  ]) {
    if (!hasObject("index", index)) return;
  }

  const entries = readMigrationJournal(migrationsDir);
  const canonicalEntries = [
    entries.find((item) => item.tag === "0017_sour_madame_web"),
    entries.find((item) => item.tag === "0018_charming_vampiro"),
  ];
  if (canonicalEntries.some((entry) => typeof entry?.when !== "number" || !entry.tag)) return;

  const insertMigration = sqlite.prepare(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  );
  sqlite.transaction(() => {
    sqlite.exec("CREATE INDEX IF NOT EXISTS jobs_type_status_created_idx ON jobs (type, status, created_at)");
    for (const entry of canonicalEntries) {
      if (!entry?.tag || typeof entry.when !== "number") continue;
      const recorded = sqlite.prepare(
        "SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1",
      ).get(entry.when);
      if (recorded) continue;
      const migrationSql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
      const hash = createHash("sha256").update(migrationSql).digest("hex");
      insertMigration.run(hash, entry.when);
    }
  })();
}

/** Repair installs whose migration cursor advanced past the room duplicate
 * migration even though that additive migration was only partially applied. */
function repairIncompleteRoomDuplicateMigration(
  sqlite: Database.Database,
  migrationsDir: string,
): void {
  const hasObject = (type: "table" | "index", name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
  ).get(type, name));
  if (!hasObject("table", "__drizzle_migrations")) return;

  const entry = readMigrationJournal(migrationsDir).find((item) => item.tag === "0031_room_duplicates");
  if (!entry?.tag || typeof entry.when !== "number") return;
  const latest = sqlite.prepare(
    "SELECT MAX(created_at) AS created_at FROM __drizzle_migrations",
  ).get() as { created_at?: number | null } | undefined;
  if (typeof latest?.created_at !== "number" || latest.created_at < entry.when) return;

  const requiredTableColumns: Record<string, string[]> = {
    room_duplicate_candidates: [
      "id", "room_a_id", "room_b_id", "name_score", "centroid_score", "content_overlap",
      "entity_overlap", "duplicate_score", "confidence", "llm_verdict", "reasons", "status",
      "evidence_revision", "scoring_version", "created_at", "updated_at",
    ],
    room_merge_operations: [
      "id", "source_room_id", "target_room_id", "idempotency_key", "preview_hash", "status",
      "stage", "progress", "commit_reached", "impact", "error", "confirmed_at", "completed_at",
      "created_at", "updated_at",
    ],
    room_merge_items: [
      "id", "operation_id", "resource_type", "resource_id", "before_room_id", "after_room_id",
      "before_value", "fingerprint", "status", "created_at", "updated_at",
    ],
    room_memory_attributions: [
      "id", "room_id", "memory_id", "source_kind", "source_id", "confidence", "created_at", "updated_at",
    ],
  };
  const requiredBaseColumns: Record<string, string[]> = {
    agent_runs: ["room_id"],
    context_rooms: ["lifecycle", "merged_into_room_id", "merged_at"],
    rooms: ["lifecycle", "merged_into_room_id", "merged_at"],
  };
  if (!Object.keys(requiredBaseColumns).every((table) => hasObject("table", table))) return;

  const columnsOf = (table: string) => new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
  const tablesComplete = Object.entries(requiredTableColumns).every(([table, columns]) =>
    hasObject("table", table) && columns.every((column) => columnsOf(table).has(column))
  );
  const baseColumnsComplete = Object.entries(requiredBaseColumns).every(([table, columns]) =>
    columns.every((column) => columnsOf(table).has(column))
  );
  const indexesComplete = [
    "room_duplicate_candidates_pair_idx",
    "room_duplicate_candidates_status_idx",
    "room_duplicate_candidates_room_a_idx",
    "room_duplicate_candidates_room_b_idx",
    "room_memory_attributions_memory_idx",
    "room_memory_attributions_room_idx",
    "room_merge_items_operation_resource_idx",
    "room_merge_items_operation_idx",
    "room_merge_operations_idempotency_idx",
    "room_merge_operations_rooms_idx",
    "room_merge_operations_status_idx",
  ].every((index) => hasObject("index", index));
  if (tablesComplete && baseColumnsComplete && indexesComplete) return;

  sqlite.transaction(() => {
    runAdditiveMigrationIdempotently(sqlite, migrationsDir, entry.tag!);
    recordMigration(sqlite, migrationsDir, entry);
  })();
}

/** Adopt late development migrations when their complete schema was already
 * applied under a discarded migration cursor. This prevents duplicate ALTER
 * statements while still allowing partially upgraded databases to migrate. */
function adoptAlreadyAppliedLateMigrations(sqlite: Database.Database, migrationsDir: string): void {
  const hasTable = (name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
  if (!hasTable("__drizzle_migrations")) return;
  const hasColumn = (table: string, column: string) => hasTable(table) && new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  ).has(column);
  const entries = readMigrationJournal(migrationsDir);
  let latestMainMigrationsEnsured = false;
  const ensureLatestMainMigrations = () => {
    if (latestMainMigrationsEnsured) return;
    latestMainMigrationsEnsured = true;
    const tags = [
      "0033_room_entity_facts",
      "0034_room_overviews_and_corrections",
      "0035_eager_hannibal_king",
    ];
    sqlite.transaction(() => {
      for (const tag of tags) runAdditiveMigrationIdempotently(sqlite, migrationsDir, tag);
      for (const tag of tags) {
        const entry = entries.find((item) => item.tag === tag);
        if (entry) recordMigration(sqlite, migrationsDir, entry);
      }
    })();
  };
  const record = (tag: string) => {
    const entry = entries.find((item) => item.tag === tag);
    if (!entry?.tag || typeof entry.when !== "number") return;
    if (sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1").get(entry.when)) return;
    const migrationSql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
    sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run(createHash("sha256").update(migrationSql).digest("hex"), entry.when);
  };

  if (hasTable("clipper_artifacts")
    && ["visual_status", "visual_kind", "visual_summary", "visual_ocr_text", "visual_key_points",
      "visual_entities", "visual_relevance", "visual_quality", "visual_model", "visual_prompt_version",
      "cover_score"].every((column) => hasColumn("clipper_assets", column))) {
    ensureLatestMainMigrations();
    record("0036_odd_cardiac");
  }
  if (hasColumn("clipper_assets", "visual_content_role")
    && hasColumn("clipper_assets", "visual_noise_reason")) {
    ensureLatestMainMigrations();
    record("0037_acoustic_doctor_spectrum");
  }
  if (hasColumn("clipper_captures", "favorited_at")) {
    ensureLatestMainMigrations();
    record("0038_clipper_favorites");
  }
  if (hasTable("agent_session_participants")
    && hasColumn("agent_sessions", "active_agent_id")
    && hasColumn("agent_runs", "agent_id")
    && hasColumn("agent_runs", "invocation_mode")
    && hasColumn("agent_messages", "author_agent_id")) {
    ensureLatestMainMigrations();
    record("0039_multi_agent_conversations");
  }
}

/** Reconcile databases created by feat/contextroom before its migration chain
 * was rebased after main's 0026-0029 migrations. */
function adoptPreMergeContextRoomMigrations(sqlite: Database.Database, migrationsDir: string): void {
  const hasObject = (type: "table" | "index", name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
  ).get(type, name));
  if (!hasObject("table", "__drizzle_migrations")) return;

  const columnsOf = (table: string) => new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!hasObject("table", "entities") || !hasObject("table", "entity_doc_links")) return;
  if (!["eligible_source_count", "trusted_source_count", "strong_source_count", "readiness_path", "scoring_version"]
    .every((column) => columnsOf("entities").has(column))) return;
  if (!["evidence_group_key", "role_weight", "source_weight", "quality_factor", "relevance_factor",
    "effective_weight", "quality_level", "trusted", "strong", "score_reasons", "scoring_version"]
    .every((column) => columnsOf("entity_doc_links").has(column))) return;

  const requiredTables: Record<string, string[]> = {
    room_source_memberships: [
      "id", "room_id", "source_kind", "source_id", "source_version", "evidence_group_key",
      "role", "effective_weight", "quality_level", "trusted", "scoring_version", "entity_indexed",
    ],
    room_entity_mentions: [
      "id", "room_id", "entity_id", "source_kind", "source_id", "source_version",
      "evidence_group_key", "salience", "relevance_factor", "quality_level", "trusted",
    ],
    room_relations: [
      "id", "room_a_id", "room_b_id", "auto_score", "auto_type", "strength",
      "shared_source_count", "shared_entity_count", "direct_mention_count", "scoring_version",
      "pinned", "hidden", "manual_type", "manual_from_room_id", "manual_to_room_id",
    ],
  };
  for (const [table, expectedColumns] of Object.entries(requiredTables)) {
    if (!hasObject("table", table)) return;
    if (!expectedColumns.every((column) => columnsOf(table).has(column))) return;
  }
  for (const index of [
    "room_source_memberships_room_source_idx",
    "room_source_memberships_source_idx",
    "room_source_memberships_group_idx",
    "room_source_memberships_room_idx",
    "room_entity_mentions_room_entity_source_idx",
    "room_entity_mentions_entity_idx",
    "room_entity_mentions_room_idx",
    "room_entity_mentions_source_idx",
    "room_relations_pair_idx",
    "room_relations_room_a_idx",
    "room_relations_room_b_idx",
    "room_relations_updated_idx",
  ]) if (!hasObject("index", index)) return;

  const journal = readMigrationJournal(migrationsDir);
  const additiveMainTags = [
    "0026_redundant_gertrude_yorkes",
    "0027_low_mockingbird",
    "0028_mighty_baron_strucker",
  ];
  sqlite.transaction(() => {
    for (const tag of additiveMainTags) runAdditiveMigrationIdempotently(sqlite, migrationsDir, tag);
    for (const tag of [...additiveMainTags, "0029_long_ikaris", "0030_room_relations_and_scoring"]) {
      const entry = journal.find((item) => item.tag === tag);
      if (entry) recordMigration(sqlite, migrationsDir, entry);
    }
    const duplicateSchemaPresent = [
      "room_duplicate_candidates",
      "room_merge_operations",
      "room_merge_items",
      "room_memory_attributions",
    ].every((table) => hasObject("table", table))
      && ["lifecycle", "merged_into_room_id", "merged_at"].every((column) => columnsOf("context_rooms").has(column))
      && ["lifecycle", "merged_into_room_id", "merged_at"].every((column) => columnsOf("rooms").has(column))
      && columnsOf("agent_runs").has("room_id")
      && [
        "room_duplicate_candidates_pair_idx",
        "room_duplicate_candidates_status_idx",
        "room_merge_operations_idempotency_idx",
        "room_merge_items_operation_resource_idx",
        "room_memory_attributions_memory_idx",
      ].every((index) => hasObject("index", index));
    if (duplicateSchemaPresent) {
      const entry = journal.find((item) => item.tag === "0031_room_duplicates");
      if (entry) recordMigration(sqlite, migrationsDir, entry);
    }
  })();
}

/** Repair installs whose migration cursor advanced across the diary/perception
 * branch without applying its schema (a transient merge produced this state). */
function repairIncompleteUnderstandingMigration(sqlite: Database.Database, migrationsDir: string): void {
  const hasObject = (type: "table" | "index", name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
  ).get(type, name));
  const hasColumn = (table: string, column: string) => new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  ).has(column);
  if (!hasObject("table", "__drizzle_migrations")) return;
  const runMigrationStatements = (tag: string) => {
    const migrationPath = join(migrationsDir, `${tag}.sql`);
    if (!existsSync(migrationPath)) return;
    const sql = readFileSync(migrationPath, "utf8");
    for (const statement of sql.split(/--> statement-breakpoint/g).map((item) => item.trim()).filter(Boolean)) {
      const createObject = statement.match(/^CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)? [`"]([^`"]+)[`"]/) ?? statement.match(/^CREATE TABLE(?: IF NOT EXISTS)? [`"]([^`"]+)[`"]/);
      if (createObject && hasObject(statement.startsWith("CREATE TABLE") ? "table" : "index", createObject[1]!)) continue;
      const addColumn = statement.match(/^ALTER TABLE [`"]([^`"]+)[`"] ADD [`"]([^`"]+)[`"]+/);
      if (addColumn && (!hasObject("table", addColumn[1]!) || hasColumn(addColumn[1]!, addColumn[2]!))) continue;
      const dropIndex = statement.match(/^DROP INDEX [`"]([^`"]+)[`"]/);
      if (dropIndex && !hasObject("index", dropIndex[1]!)) continue;
      sqlite.exec(statement);
    }
  };
  if (!hasObject("table", "diary_days")) runMigrationStatements("0018_living_secret_warriors");
  if (hasObject("table", "diary_version_sources") && !hasColumn("diary_version_sources", "ended_at")) {
    runMigrationStatements("0019_free_charles_xavier");
  }
  if (hasObject("table", "ingest_events") && !hasColumn("ingest_events", "deleted_at")) {
    sqlite.exec("ALTER TABLE `ingest_events` ADD `deleted_at` integer");
  }
  if (!hasObject("table", "connector_markdown_artifacts")) runMigrationStatements("0018_charming_vampiro");
  if (!hasObject("table", "subagent_definitions")) runMigrationStatements("0019_sturdy_fantastic_four");
  if (!hasObject("table", "runtime_config_store")) runMigrationStatements("0023_runtime_config_store");
  if (existsSync(join(migrationsDir, "0023_wide_red_hulk.sql"))
    && hasObject("table", "ingest_events")
    && !hasColumn("ingest_events", "reinstated_at")) {
    sqlite.exec("ALTER TABLE `ingest_events` ADD `reinstated_at` integer");
  }
  if (!hasObject("table", "agent_schedules")) runMigrationStatements("0025_greedy_the_santerians");
}

export function createDatabase(databasePath: string, migrationsDir: string): DatabaseClient {
  mkdirSync(dirname(databasePath), { recursive: true });

  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("secure_delete = ON");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  repairLegacyMigrationCursor(sqlite, migrationsDir);
  adoptPreReleaseConnectorConfigMigration(sqlite, migrationsDir);
  adoptPreReleaseConnectorMarkdownMigrations(sqlite, migrationsDir);
  repairIncompleteRoomDuplicateMigration(sqlite, migrationsDir);
  adoptAlreadyAppliedLateMigrations(sqlite, migrationsDir);
  adoptPreMergeContextRoomMigrations(sqlite, migrationsDir);
  repairContextRoomSchema(sqlite);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });
  sqlite.exec("CREATE INDEX IF NOT EXISTS jobs_type_status_created_idx ON jobs (type, status, created_at)");
  // Preserve canonical migration markers when a pre-release branch inserted
  // later timestamps before the main branch was adopted.
  const journalEntries = readMigrationJournal(migrationsDir);
  const insertMigration = sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
  for (const entry of journalEntries.filter((item) => typeof item.when === "number" && (item.tag?.startsWith("0017_") || item.tag?.startsWith("0018_") || item.tag?.startsWith("0019_")))) {
    if (!entry.tag || typeof entry.when !== "number") continue;
    if (sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1").get(entry.when)) continue;
    const migrationPath = join(migrationsDir, `${entry.tag}.sql`);
    if (!existsSync(migrationPath)) continue;
    insertMigration.run(createHash("sha256").update(readFileSync(migrationPath, "utf8")).digest("hex"), entry.when);
  }
  // Drizzle identifies migrations by timestamp; the merged branch contains
  // two 0018/0019 entries with overlapping timestamps. Re-run the idempotent
  // compatibility pass after migrate so fresh databases receive whichever
  // branch migration Drizzle skipped.
  repairIncompleteUnderstandingMigration(sqlite, migrationsDir);

  return { db, sqlite };
}

export type GatewayDatabase = ReturnType<typeof createDatabase>["db"];
