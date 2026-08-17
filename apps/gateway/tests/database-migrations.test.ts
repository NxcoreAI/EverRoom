import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { DocumentEventBroker } from "../src/modules/documents/event-broker.js";
import { DocumentService } from "../src/modules/documents/service.js";

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
    const blockColumns = upgraded.sqlite.prepare("PRAGMA table_info(document_blocks)")
      .all() as Array<{ name: string }>;
    const documentColumns = upgraded.sqlite.prepare("PRAGMA table_info(documents)")
      .all() as Array<{ name: string }>;
    upgraded.sqlite.close();

    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "documents",
      "document_blocks",
      "document_block_references",
      "document_patches",
      "document_patch_hunks",
      "doc_transactions",
      "reality_events",
    ]));
    expect(patchColumns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "accepted_block_ids",
      "rejected_block_ids",
    ]));
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
  });

  it("preserves canonical content and rebuilds disposable block projections from a 0009 database", async () => {
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
    const legacyEntries = journal.entries.filter((entry) => entry.idx <= 9);
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
    const expectedCanonical = {
      type: "doc",
      content: [
        { type: "documentTitle", content: [{ type: "text", text: "Migrated" }] },
        ...canonical.content,
      ],
    };
    const legacy = createDatabase(databasePath, legacyMigrationsDir);
    const now = Date.now();
    legacy.sqlite.prepare(
      "INSERT INTO documents (id, title, content_json, version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("doc-migrated", "Migrated", JSON.stringify(canonical), 1, "active", now, now);
    legacy.sqlite.prepare(
      "INSERT INTO room_doc_links (room_id, document_id, linked_at) VALUES (?, ?, ?)",
    ).run("room-1", "doc-migrated", now);
    legacy.sqlite.prepare(
      "INSERT INTO doc_versions (id, document_id, version, content_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("version-1", "doc-migrated", 1, JSON.stringify(canonical), now);
    legacy.sqlite.prepare(
      "INSERT INTO document_blocks (id, document_id, parent_block_id, type, ordinal, path, text_preview) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("stale-block", "doc-migrated", null, "paragraph", 0, "[0]", "stale");
    legacy.sqlite.close();

    const upgraded = createDatabase(databasePath, currentMigrationsDir);
    const service = new DocumentService(upgraded.db, new DocumentEventBroker());
    try {
      expect(service.get("doc-migrated")?.contentJson).toEqual(expectedCanonical);
      expect(service.listBlocks("doc-migrated")).toEqual([
        expect.objectContaining({
          blockId: "preserved-block",
          textPreview: "canonical content",
          indexedVersion: 1,
        }),
      ]);
    } finally {
      service.dispose();
      upgraded.sqlite.close();
    }
  });
});
