import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

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

export function createDatabase(databasePath: string, migrationsDir: string): DatabaseClient {
  mkdirSync(dirname(databasePath), { recursive: true });

  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  repairLegacyMigrationCursor(sqlite, migrationsDir);
  adoptPreReleaseConnectorConfigMigration(sqlite, migrationsDir);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });

  return { db, sqlite };
}

export type GatewayDatabase = ReturnType<typeof createDatabase>["db"];
