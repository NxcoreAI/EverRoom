import { mkdirSync, rmSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";

const migrationsDir = join(import.meta.dirname, "../drizzle");

function buildSkippedMigrationDb(target: string): void {
  // Fully migrate a fresh DB first (which includes 0046/0047), then surgically
  // remove those two markers AND the tables they created — reproducing the
  // intermediate-build state where the cursor jumped past them.
  const sqlite = new Database(target);
  sqlite.pragma("journal_mode = WAL");
  sqlite.close();
  const { sqlite: migrated } = createDatabase(target, migrationsDir);
  migrated.close();

  const sqlite2 = new Database(target);
  const journal = JSON.parse(
    readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ).entries as Array<{ tag: string; when: number }>;
  for (const tag of ["0046_dear_nitro", "0047_same_namor"]) {
    const entry = journal.find((item) => item.tag === tag)!;
    sqlite2.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(entry.when);
  }
  for (const table of [
    "writing_style_document_sketches", "writing_style_profiles", "writing_style_settings",
    "writing_style_user_content", "writing_style_signals",
  ]) {
    sqlite2.exec(`DROP TABLE IF EXISTS \`${table}\``);
  }
  sqlite2.close();
}

describe("repair skipped writing-style migrations (0046/0047)", () => {
  it("backfills writing_style tables when the migration cursor skipped them", () => {
    const dir = mkdtempSync(join(tmpdir(), "everroom-repair-"));
    const target = join(dir, "database", "gateway.sqlite");
    mkdirSync(join(dir, "database"), { recursive: true });
    buildSkippedMigrationDb(target);

    const { sqlite } = createDatabase(target, migrationsDir);

    const tables = new Set(
      (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    expect(tables.has("writing_style_signals")).toBe(true);
    expect(tables.has("writing_style_profiles")).toBe(true);
    expect(tables.has("writing_style_settings")).toBe(true);
    expect(tables.has("writing_style_user_content")).toBe(true);
    expect(tables.has("writing_style_document_sketches")).toBe(true);
    expect(tables.has("writing_style_insights")).toBe(true);

    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ).entries as Array<{ tag: string; when: number }>;
    for (const tag of ["0046_dear_nitro", "0047_same_namor"]) {
      const entry = journal.find((item) => item.tag === tag)!;
      const recorded = sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1").get(entry.when);
      expect(recorded).toBeTruthy();
    }

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op for a healthy database without the gap", () => {
    const dir = mkdtempSync(join(tmpdir(), "everroom-healthy-"));
    const target = join(dir, "database", "gateway.sqlite");
    mkdirSync(join(dir, "database"), { recursive: true });
    const { sqlite } = createDatabase(target, migrationsDir);
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ).entries as Array<{ tag: string; when: number }>;
    expect(count).toBe(journal.length);
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
