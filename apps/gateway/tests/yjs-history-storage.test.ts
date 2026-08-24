import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { TiptapJsonContent } from "@nxcore/agent-contract";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import {
  documentYjsCheckpoints,
  documentYjsUpdates,
} from "../src/infrastructure/database/schema.js";
import {
  DocumentCommitService,
  DocumentContentEngine,
  DocumentRepository,
  YjsHistoryService,
} from "../src/modules/documents/core/index.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];

const DOCUMENT_ID = "doc-storage-optimization";
const ROOM_ID = "room-storage-optimization";
const TITLE = "存储优化";

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-yjs-history-storage-test-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  const repository = new DocumentRepository(database.db);
  const engine = new DocumentContentEngine({
    findDocumentRoom: (documentId) => repository.get(documentId)?.roomId ?? null,
  });
  const commits = new DocumentCommitService(database.db, repository, engine);
  const history = new YjsHistoryService();
  return { database, commits, history };
}

afterEach(async () => {
  databases.splice(0).forEach((database) => database.sqlite.close());
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function versionText(version: number): string {
  return String(version).padStart(3, "0");
}

function body(version: number): TiptapJsonContent {
  return {
    type: "doc",
    content: [{
      type: "paragraph",
      attrs: { id: "block-1" },
      content: [{ type: "text", text: versionText(version) }],
    }],
  };
}

function writeHistory(commits: DocumentCommitService, throughVersion: number): void {
  commits.create({
    documentId: DOCUMENT_ID,
    roomId: ROOM_ID,
    title: TITLE,
    content: body(1),
    version: 1,
  });
  for (let version = 2; version <= throughVersion; version += 1) {
    commits.commit({
      documentId: DOCUMENT_ID,
      roomId: ROOM_ID,
      title: TITLE,
      content: body(version),
      expectedVersion: version - 1,
      version,
    });
  }
}

function firstText(content: TiptapJsonContent | null | undefined): string {
  const block = content?.content?.[0];
  if (!block) return "";
  if (block.type === "text" && typeof block.text === "string") return block.text;
  const inline = block.content?.[0];
  return inline?.type === "text" && typeof inline.text === "string" ? inline.text : "";
}

function columnNames(database: DatabaseClient, table: string): Set<string> {
  return new Set((database.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name));
}

describe("Yjs history storage optimization", () => {
  it("no longer persists a state vector per version", async () => {
    const { database } = await setup();
    expect(columnNames(database, "document_yjs_versions").has("state_vector")).toBe(false);
    expect(columnNames(database, "document_yjs_checkpoints").has("state_vector")).toBe(false);
  });

  it("keeps checkpoints compact and bounded regardless of total version count", async () => {
    const { database, commits } = await setup();
    writeHistory(commits, 201);

    const checkpoints = database.db.select().from(documentYjsCheckpoints)
      .where(eq(documentYjsCheckpoints.documentId, DOCUMENT_ID))
      .orderBy(asc(documentYjsCheckpoints.throughVersion)).all();
    expect(checkpoints.map((checkpoint) => checkpoint.throughVersion)).toEqual([1, 100, 200]);

    const updateCount = database.db.select().from(documentYjsUpdates)
      .where(eq(documentYjsUpdates.documentId, DOCUMENT_ID)).all().length;
    expect(updateCount).toBe(201);

    const size100 = checkpoints.find((checkpoint) => checkpoint.throughVersion === 100)!.docState.byteLength;
    const size200 = checkpoints.find((checkpoint) => checkpoint.throughVersion === 200)!.docState.byteLength;
    expect(size100).toBeGreaterThan(0);
    expect(size200).toBeGreaterThan(0);
    expect(size100).toBeLessThan(2048);
    expect(size200).toBeLessThan(2048);
    expect(Math.abs(size200 - size100)).toBeLessThanOrEqual(64);
  });

  it("materializes and diffs across checkpoints", async () => {
    const { database, commits, history } = await setup();
    writeHistory(commits, 201);

    expect(firstText(history.materialize(database.db, DOCUMENT_ID, 99)?.content)).toBe("099");
    expect(firstText(history.materialize(database.db, DOCUMENT_ID, 100)?.content)).toBe("100");
    expect(firstText(history.materialize(database.db, DOCUMENT_ID, 101)?.content)).toBe("101");
    expect(firstText(history.materialize(database.db, DOCUMENT_ID, 200)?.content)).toBe("200");
    expect(firstText(history.materialize(database.db, DOCUMENT_ID, 201)?.content)).toBe("201");

    const diff = history.diff(database.db, DOCUMENT_ID, 99, 201);
    expect(diff).not.toBeNull();
    expect(diff?.blocks).toHaveLength(1);
    expect(diff?.blocks[0]).toMatchObject({ blockId: "block-1", status: "modified" });
    expect(diff?.yjsBackfilled).toBe(true);
  });
});
