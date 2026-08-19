import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { documentVersions } from "../src/infrastructure/database/schema.js";
import {
  DocumentCommitService,
  DocumentContentEngine,
  DocumentRepository,
} from "../src/modules/documents/core/index.js";

const temporaryDirectories: string[] = [];
const disposables: Array<() => void> = [];

async function createCore() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-document-core-test-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  disposables.push(() => sqlite.close());
  const repository = new DocumentRepository(db);
  const engine = new DocumentContentEngine({
    findDocumentRoom: (documentId) => repository.get(documentId)?.roomId ?? null,
  });
  return { db, repository, engine, commits: new DocumentCommitService(db, repository, engine) };
}

afterEach(async () => {
  for (const dispose of disposables.splice(0)) dispose();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("document core", () => {
  it("rejects embedded image bytes on new writes while allowing legacy content to load for migration", () => {
    const engine = new DocumentContentEngine();
    const embedded = {
      type: "doc",
      content: [{ type: "image", attrs: { src: "data:image/png;base64,iVBORw0KGgo=" } }],
    };
    expect(() => engine.normalizeDocument(embedded, "doc-1", "room-1"))
      .toThrowError(expect.objectContaining({ code: "EMBEDDED_IMAGE_NOT_ALLOWED", statusCode: 400 }));
    expect(engine.normalizeStoredDocument(embedded, "doc-legacy", "room-1", 3).content)
      .toMatchObject(embedded);
  });

  it("keeps fragment normalization free of document title metadata", () => {
    const engine = new DocumentContentEngine();
    const fragment = engine.normalizeFragment({
      type: "doc",
      content: [
        { type: "documentTitle", content: [{ type: "text", text: "污染标题" }] },
        { type: "paragraph", content: [{ type: "text", text: "片段正文" }] },
      ],
    }, "doc-1", "room-1");

    expect(fragment.content.content?.map((node) => node.type)).toEqual(["paragraph"]);
    expect(fragment.blocks).toEqual([expect.objectContaining({ documentId: "doc-1", roomId: "room-1" })]);
  });

  it("routes stored content through schema migration and rejects newer schemas", () => {
    const engine = new DocumentContentEngine();
    const migrated = engine.normalizeStoredDocument(
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "legacy" }] }] },
      "doc-legacy",
      "room-1",
      1,
      4,
    );

    expect(migrated).toMatchObject({ schemaVersion: 3 });
    expect(migrated.blocks[0]).toMatchObject({ documentId: "doc-legacy", indexedVersion: 4 });
    expect(() => engine.normalizeStoredDocument(
      { type: "doc", content: [] },
      "doc-future",
      "room-1",
      999,
    )).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_DOCUMENT_SCHEMA", statusCode: 409 }));
  });

  it("commits title snapshots and strips retired title nodes atomically", async () => {
    const { db, commits, repository } = await createCore();
    const created = commits.create({
      documentId: "doc-core",
      roomId: "room-core",
      title: "第一版标题",
      content: {
        type: "doc",
        content: [
          { type: "documentTitle", content: [{ type: "text", text: "不能覆盖标题" }] },
          { type: "paragraph", content: [{ type: "text", text: "第一版" }] },
        ],
      },
      version: 1,
    });
    const updated = commits.commit({
      documentId: created.id,
      roomId: created.roomId,
      title: "第二版标题",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "第二版" }] }] },
      version: 2,
    });

    expect(updated.title).toBe("第二版标题");
    expect(updated.contentJson.content?.some((node) => node.type === "documentTitle")).toBe(false);
    expect(repository.listBlocks(updated)[0]).toMatchObject({ indexedVersion: 2, textPreview: "第二版" });
    expect(db.select().from(documentVersions).where(eq(documentVersions.documentId, created.id)).all()
      .map((version) => [version.version, version.title])).toEqual([
        [1, "第一版标题"],
        [2, "第二版标题"],
      ]);
  });

  it("uses expectedVersion as a transactional compare-and-swap guard", async () => {
    const { db, commits, repository } = await createCore();
    commits.create({
      documentId: "doc-cas",
      roomId: "room-core",
      title: "Current",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "v1" }] }] },
      version: 1,
    });

    expect(() => commits.commit({
      documentId: "doc-cas",
      roomId: "room-core",
      title: "Stale",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "v2" }] }] },
      expectedVersion: 0,
      version: 2,
    })).toThrowError(expect.objectContaining({ code: "DOCUMENT_CONFLICT", statusCode: 409 }));

    expect(repository.get("doc-cas")).toMatchObject({ title: "Current", version: 1 });
    expect(db.select().from(documentVersions).where(eq(documentVersions.documentId, "doc-cas")).all())
      .toHaveLength(1);
  });
});
