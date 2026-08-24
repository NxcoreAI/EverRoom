import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  documentYjsUpdates,
  documentYjsVersions,
  documents,
  documentVersions,
  jobs,
} from "../src/infrastructure/database/schema.js";
import {
  DocumentCommitService,
  DocumentContentEngine,
  DocumentRepository,
  YjsHistoryService,
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

  it("stores incremental Yjs history and materializes structured diffs", async () => {
    const { db, commits } = await createCore();
    const first = commits.create({
      documentId: "doc-yjs",
      roomId: "room-core",
      title: "历史一",
      content: { type: "doc", content: [{ type: "paragraph", attrs: { id: "block-1" }, content: [{ type: "text", text: "旧内容" }] }] },
      version: 1,
    });
    commits.commit({
      documentId: first.id,
      roomId: first.roomId,
      title: "历史二",
      content: { type: "doc", content: [{ type: "paragraph", attrs: { id: "block-1" }, content: [{ type: "text", text: "新内容" }] }, { type: "paragraph", attrs: { id: "block-2" }, content: [{ type: "text", text: "新增" }] }] },
      expectedVersion: 1,
      version: 2,
    });

    expect(db.select().from(documentYjsUpdates).where(eq(documentYjsUpdates.documentId, first.id)).all()).toHaveLength(2);
    expect(db.select().from(documentYjsVersions).where(eq(documentYjsVersions.documentId, first.id)).all()).toHaveLength(2);
    const history = new YjsHistoryService();
    expect(history.materialize(db, first.id, 1)?.content.content?.[0]).toMatchObject({ attrs: { id: "block-1" } });
    expect(history.materialize(db, first.id, 2)?.content.content).toHaveLength(2);
    expect(history.diff(db, first.id, 1, 2)).toMatchObject({
      yjsBackfilled: true,
      blocks: expect.arrayContaining([
        expect.objectContaining({ blockId: "block-1", status: "modified" }),
        expect.objectContaining({ blockId: "block-2", status: "added" }),
      ]),
    });
  });

  it("retains only checkpoint and current JSON snapshots while rebuilding older versions from Yjs", async () => {
    const { db, commits, repository } = await createCore();
    const first = commits.create({
      documentId: "doc-snapshot-retention",
      roomId: "room-core",
      title: "快照保留",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "V1" }] }] },
      version: 1,
    });
    const second = commits.commit({
      documentId: first.id,
      roomId: first.roomId,
      title: first.title,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "V2" }] }] },
      expectedVersion: 1,
      version: 2,
    });
    commits.commit({
      documentId: first.id,
      roomId: first.roomId,
      title: first.title,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "V3" }] }] },
      expectedVersion: second.version,
      version: 3,
    });

    expect(repository.getVersion(first.id, 2)?.contentJson).toBeNull();
    const history = new YjsHistoryService();
    expect(history.materialize(db, first.id, 2)?.content).toMatchObject({
      content: [{ content: [{ text: "V2" }] }],
    });
    expect(history.materialize(db, first.id, 3)?.content).toMatchObject({
      content: [{ content: [{ text: "V3" }] }],
    });
  });

  it("fails closed when a released snapshot can no longer be reconstructed from Yjs", async () => {
    const { db, commits } = await createCore();
    const first = commits.create({
      documentId: "doc-corrupt-compacted-history",
      roomId: "room-core",
      title: "损坏历史",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "V1" }] }] },
      version: 1,
    });
    commits.commit({
      documentId: first.id,
      roomId: first.roomId,
      title: first.title,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "V2" }] }] },
      expectedVersion: 1,
      version: 2,
    });
    commits.commit({
      documentId: first.id,
      roomId: first.roomId,
      title: first.title,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "V3" }] }] },
      expectedVersion: 2,
      version: 3,
    });

    db.update(documentYjsUpdates).set({ contentHash: "corrupt" })
      .where(and(eq(documentYjsUpdates.documentId, first.id), eq(documentYjsUpdates.version, 2))).run();

    const history = new YjsHistoryService();
    expect(history.materialize(db, first.id, 2)).toBeNull();
    expect(() => history.rebuildDocument(db, first.id)).toThrow(/version 2 cannot be reconstructed/);
  });

  it("does not turn an insertion before legacy path-based blocks into edits", async () => {
    const { db } = await createCore();
    const history = new YjsHistoryService();
    const v1 = {
      type: "doc" as const,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "A" }] },
        { type: "paragraph", content: [{ type: "text", text: "B" }] },
      ],
    };
    const v2 = {
      type: "doc" as const,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "X" }] },
        { type: "paragraph", content: [{ type: "text", text: "A" }] },
        { type: "paragraph", content: [{ type: "text", text: "B" }] },
      ],
    };
    db.insert(documents).values({
      id: "doc-legacy-diff",
      title: "Legacy",
      contentJson: v2,
      version: 2,
      status: "active",
    }).run();
    db.transaction((tx) => {
      tx.insert(documentVersions).values([
        { id: "doc-legacy-diff-v1", documentId: "doc-legacy-diff", version: 1, title: "Legacy", contentJson: v1 },
        { id: "doc-legacy-diff-v2", documentId: "doc-legacy-diff", version: 2, title: "Legacy", contentJson: v2 },
      ]).run();
      history.writeCommit(tx, {
        documentId: "doc-legacy-diff", version: 1, title: "Legacy", content: v1,
        contentSchemaVersion: 1, now: new Date(1), backfilled: true,
      });
      history.writeCommit(tx, {
        documentId: "doc-legacy-diff", version: 2, title: "Legacy", content: v2,
        contentSchemaVersion: 1, now: new Date(2), backfilled: true,
      });
    });

    const blocks = history.diff(db, "doc-legacy-diff", 1, 2)?.blocks.filter((block) => block.path.length === 1);
    expect(blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "added", after: expect.objectContaining({ content: [expect.objectContaining({ text: "X" })] }) }),
      expect.objectContaining({ status: "unchanged", after: expect.objectContaining({ content: [expect.objectContaining({ text: "A" })] }), textDiff: [{ type: "equal", text: "A" }] }),
      expect.objectContaining({ status: "unchanged", after: expect.objectContaining({ content: [expect.objectContaining({ text: "B" })] }), textDiff: [{ type: "equal", text: "B" }] }),
    ]));
    expect(blocks?.some((block) => block.status === "modified")).toBe(false);
  });

  it("ignores regenerated stable block ids when the block content is unchanged", async () => {
    const { db, commits } = await createCore();
    const first = commits.create({
      documentId: "doc-id-churn",
      roomId: "room-core",
      title: "ID churn",
      content: {
        type: "doc",
        content: [{
          type: "heading",
          attrs: { id: "old-heading-id", level: 2 },
          content: [{ type: "text", text: "Layered Architecture" }],
        }],
      },
      version: 1,
    });
    commits.commit({
      documentId: first.id,
      roomId: first.roomId,
      title: first.title,
      content: {
        type: "doc",
        content: [{
          type: "heading",
          attrs: { id: "new-heading-id", level: 2 },
          content: [{ type: "text", text: "Layered Architecture" }],
        }],
      },
      expectedVersion: 1,
      version: 2,
    });

    const blocks = new YjsHistoryService().diff(db, first.id, 1, 2)?.blocks.filter((block) => block.path.length === 1);
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]).toMatchObject({ status: "unchanged", type: "heading" });
  });

  it("ignores TableOfContents metadata churn when heading text is unchanged", async () => {
    const { db, commits } = await createCore();
    const first = commits.create({
      documentId: "doc-toc-metadata-churn",
      roomId: "room-core",
      title: "TOC metadata",
      content: {
        type: "doc",
        content: [{
          type: "heading",
          attrs: { id: "heading-v1", level: 2 },
          content: [{ type: "text", text: "安装 TypeScript" }],
        }],
      },
      version: 1,
    });
    commits.commit({
      documentId: first.id,
      roomId: first.roomId,
      title: first.title,
      content: {
        type: "doc",
        content: [{
          type: "heading",
          attrs: {
            id: "heading-v2",
            "data-toc-id": "heading-v2",
            level: 2,
          },
          content: [{ type: "text", text: "安装 TypeScript" }],
        }],
      },
      expectedVersion: 1,
      version: 2,
    });

    const blocks = new YjsHistoryService().diff(db, first.id, 1, 2)?.blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]).toMatchObject({ status: "unchanged", type: "heading" });
  });

  it("ignores JSON property-order churn when block semantics are unchanged", async () => {
    const { db, commits } = await createCore();
    const first = commits.create({
      documentId: "doc-property-order-churn",
      roomId: "room-core",
      title: "Property order",
      content: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [
            { type: "text", text: "安装完成后，你可以使用 " },
            { type: "text", text: "tsc", marks: [{ type: "code" }] },
            { type: "text", text: " 命令来编译 TypeScript 文件。" },
          ],
          attrs: { id: "paragraph-1" },
        }],
      },
      version: 1,
    });
    commits.commit({
      documentId: first.id,
      roomId: first.roomId,
      title: first.title,
      content: {
        type: "doc",
        content: [{
          type: "paragraph",
          attrs: { id: "paragraph-1" },
          content: [
            { type: "text", text: "安装完成后，你可以使用 " },
            { type: "text", marks: [{ type: "code" }], text: "tsc" },
            { type: "text", text: " 命令来编译 TypeScript 文件。" },
          ],
        }],
      },
      expectedVersion: 1,
      version: 2,
    });

    const blocks = new YjsHistoryService().diff(db, first.id, 1, 2)?.blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]).toMatchObject({ status: "unchanged", type: "paragraph" });
  });

  it("backfills legacy history in bounded, resumable batches", async () => {
    const { db } = await createCore();
    const history = new YjsHistoryService();
    const content = (text: string) => ({
      type: "doc" as const,
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    db.insert(documents).values({
      id: "doc-bounded-backfill",
      title: "旧历史",
      contentJson: content("V3"),
      version: 3,
      status: "active",
    }).run();
    db.insert(documentVersions).values([1, 2, 3].map((version) => ({
      id: `doc-bounded-backfill-v${version}`,
      documentId: "doc-bounded-backfill",
      version,
      title: "旧历史",
      contentJson: content(`V${version}`),
    }))).run();

    expect(history.backfillDocument(db, "doc-bounded-backfill", 1)).toBe(1);
    expect(history.backfillDocument(db, "doc-bounded-backfill", 1)).toBe(1);
    expect(history.backfillDocument(db, "doc-bounded-backfill", 1)).toBe(1);
    expect(history.backfillDocument(db, "doc-bounded-backfill", 1)).toBe(0);
    expect(db.select().from(documentYjsVersions).where(eq(documentYjsVersions.documentId, "doc-bounded-backfill")).all())
      .toHaveLength(3);
  });

  it("returns a bounded summary instead of building an unbounded large diff", async () => {
    const { commits, db } = await createCore();
    const content = (prefix: string) => ({
      type: "doc" as const,
      content: Array.from({ length: 501 }, (_, index) => ({
        type: "paragraph",
        content: [{ type: "text", text: `${prefix}-${index}` }],
      })),
    });
    const first = commits.create({
      documentId: "doc-large-diff",
      roomId: "room-core",
      title: "大文档",
      content: content("old"),
      version: 1,
    });
    commits.commit({
      documentId: first.id,
      roomId: first.roomId,
      title: first.title,
      content: content("new"),
      expectedVersion: 1,
      version: 2,
    });

    const result = new YjsHistoryService().diff(db, "doc-large-diff", 1, 2);
    expect(result).toMatchObject({ truncated: true, truncatedReason: "too_large", blocks: [{ status: "modified" }] });
  });

  it("counts top-level blocks instead of inline text nodes for diff limits", async () => {
    const { commits, db } = await createCore();
    const content = {
      type: "doc" as const,
      content: Array.from({ length: 1_001 }, (_, index) => ({
        type: "paragraph",
        content: [{ type: "text", text: `line-${index}` }],
      })),
    };
    const document = commits.create({
      documentId: "doc-top-level-diff-limit",
      roomId: "room-core",
      title: "顶层块限制",
      content,
      version: 1,
    });

    const result = new YjsHistoryService().diff(db, document.id, null, 1);
    expect(result?.truncated).toBeUndefined();
    expect(result?.blocks).toHaveLength(1_001);
  });

  it("registers committed versions in the document outbox but skips version-zero drafts", async () => {
    const { db, commits } = await createCore();
    commits.create({
      documentId: "doc-draft",
      roomId: "room-core",
      title: "Draft",
      content: { type: "doc", content: [{ type: "paragraph" }] },
      version: 0,
      status: "draft",
    });
    commits.create({
      documentId: "doc-committed",
      roomId: "room-core",
      title: "Committed",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] },
      version: 1,
    });

    const queued = db.select().from(jobs).all();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: "document.ingest",
      status: "pending",
      payload: expect.objectContaining({ documentId: "doc-committed", roomId: "room-core", version: 1 }),
    });
  });

  it("rolls back the document, version, projections, and outbox job together", async () => {
    const { db, commits } = await createCore();

    expect(() => commits.create({
      documentId: "doc-rollback",
      roomId: "room-core",
      title: "Rollback",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] },
      version: 1,
      mutate: () => { throw new Error("abort transaction"); },
    })).toThrow("abort transaction");

    expect(db.select().from(documents).where(eq(documents.id, "doc-rollback")).get()).toBeUndefined();
    expect(db.select().from(documentVersions).where(eq(documentVersions.documentId, "doc-rollback")).all())
      .toEqual([]);
    expect(db.select().from(jobs).all()).toEqual([]);
  });
});
