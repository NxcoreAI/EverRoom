import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const patchColumns = upgraded.sqlite.prepare("PRAGMA table_info(document_patches)")
      .all() as Array<{ name: string }>;
    upgraded.sqlite.close();

    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "documents",
      "document_blocks",
      "document_patches",
      "document_patch_hunks",
      "doc_transactions",
      "reality_events",
    ]));
    expect(patchColumns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "accepted_block_ids",
      "rejected_block_ids",
    ]));
  });
});
