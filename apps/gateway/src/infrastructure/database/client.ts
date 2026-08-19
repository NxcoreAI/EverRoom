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

  let canonicalFirstMigrationAt: number | null = null;
  try {
    const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
      entries?: Array<{ tag?: string; when?: number }>;
    };
    const entry = journal.entries?.find((item) => item.tag === "0010_tricky_mongoose");
    canonicalFirstMigrationAt = typeof entry?.when === "number" ? entry.when : null;
  } catch {
    return;
  }
  if (canonicalFirstMigrationAt === null) return;

  const hasLegacyCursor = sqlite.prepare(
    "SELECT 1 FROM __drizzle_migrations WHERE created_at >= ? LIMIT 1",
  ).get(canonicalFirstMigrationAt);
  if (!hasLegacyCursor) return;
  sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?").run(canonicalFirstMigrationAt);
}

export function createDatabase(databasePath: string, migrationsDir: string): DatabaseClient {
  mkdirSync(dirname(databasePath), { recursive: true });

  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  repairLegacyMigrationCursor(sqlite, migrationsDir);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });

  return { db, sqlite };
}

export type GatewayDatabase = ReturnType<typeof createDatabase>["db"];
