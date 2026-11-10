import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";
import type { GatewayDatabase } from "../src/infrastructure/database/client.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { agentWorkspaces, fileEntries } from "../src/infrastructure/database/schema.js";
import { FilesService } from "../src/modules/files/service.js";
import { SpaceLibraryWriter, safeLibraryFileName } from "../src/modules/workspace-layout/library.js";
import { reconcileSpaceLibrary } from "../src/modules/workspace-layout/reconcile.js";
import { WorkspaceLayoutService } from "../src/modules/workspace-layout/service.js";

/**
 * 资料库落盘（P1 + v2 布局）验收：
 * - 入库即写 `<space>/<name>`（根即资料库，新文件平铺），DB `relativePath` 与磁盘一致；
 * - 改名改磁盘、删除进 `.everoffice/trash`；
 * - `reconcile` 三向收敛（少了→missing、回来了→恢复、多了→入库）；
 * - 存量懒回填能把"只在对象库里的"条目补成真文件。
 *
 * 方案：docs/project-space-layout-plan.zh-CN.md §8.3 / §12.1.3
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function spaceForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-space-library-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const layout = new WorkspaceLayoutService({ dataDir });
  const writer = new SpaceLibraryWriter(database.db, dataDir, layout);
  const files = new FilesService(database.db, dataDir);
  files.initializeCatalog();
  files.setSpaceLibrary(writer);

  const spaceId = "ws-library";
  const provisioned = layout.provision({ spaceId, name: "Library test", rootMode: "managed" });
  database.db.insert(agentWorkspaces).values({
    id: spaceId,
    name: "Library test",
    description: null,
    goals: [],
    path: provisioned.paths.root,
    slug: provisioned.marker.slug,
    rootMode: "managed",
    layoutVersion: 2,
    kind: "custom",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastOpenedAt: new Date(),
  }).run();

  return { ...database, layout, writer, files, dataDir, spaceId, root: provisioned.paths.root };
}

async function catalogRow(files: FilesService, fileEntryId: string) {
  return files.catalogEntry(fileEntryId);
}

function stateOf(db: GatewayDatabase, fileEntryId: string): string | undefined {
  return db.select({ state: fileEntries.state }).from(fileEntries)
    .where(eq(fileEntries.id, fileEntryId)).get()?.state;
}

describe("project space library (P1)", () => {
  it("writes imported bytes flat into the space root and records the relative path", async () => {
    const test = await spaceForTest();
    const imported = await test.files.importFile({
      sourceKind: "manual-upload",
      sourceKey: "upload:quarterly",
      originalName: "季度汇报.md",
      workspaceId: test.spaceId,
      buffer: Buffer.from("# Q3", "utf8"),
    });

    const item = await catalogRow(test.files, imported.fileEntryId);
    expect(item?.relativePath).toBe("季度汇报.md");
    const onDisk = join(test.root, "季度汇报.md");
    expect(existsSync(onDisk)).toBe(true);
    expect(await readFile(onDisk, "utf8")).toBe("# Q3");
    // 内容寻址副本也在空间里（版本快照/去重）。
    expect(existsSync(join(test.root, ".everoffice", "objects", imported.contentHash))).toBe(true);
  });

  it("puts agent artifacts and connector imports flat in the root", async () => {
    const test = await spaceForTest();
    await test.files.importFile({
      sourceKind: "agent-generated",
      sourceKey: "agent:deck",
      originalName: "deck.md",
      workspaceId: test.spaceId,
      buffer: Buffer.from("# deck", "utf8"),
    });
    await test.files.importFile({
      sourceKind: "connector",
      sourceKey: "connector:doc",
      originalName: "memo.md",
      provider: "feishu",
      workspaceId: test.spaceId,
      buffer: Buffer.from("# memo", "utf8"),
    });

    expect(existsSync(join(test.root, "deck.md"))).toBe(true);
    expect(existsSync(join(test.root, "memo.md"))).toBe(true);
  });

  it("renames on disk and trashes on delete", async () => {
    const test = await spaceForTest();
    const imported = await test.files.importFile({
      sourceKind: "manual-upload",
      sourceKey: "upload:rename",
      originalName: "old name.md",
      workspaceId: test.spaceId,
      buffer: Buffer.from("# rename me", "utf8"),
    });

    await test.files.renameCatalogEntry(imported.fileEntryId, "new name");
    expect(existsSync(join(test.root, "old name.md"))).toBe(false);
    expect(existsSync(join(test.root, "new name.md"))).toBe(true);
    expect((await catalogRow(test.files, imported.fileEntryId))?.relativePath).toBe("new name.md");

    await test.files.deleteCatalogEntry(imported.fileEntryId);
    expect(existsSync(join(test.root, "new name.md"))).toBe(false);
    const trashRoot = join(test.root, ".everoffice", "trash");
    const trashDays = await readdir(trashRoot);
    expect(trashDays).toHaveLength(1);
    const buckets = await readdir(join(trashRoot, trashDays[0]!));
    expect(buckets).toHaveLength(1);
    const trashed = await readdir(join(trashRoot, trashDays[0]!, buckets[0]!));
    expect(trashed).toEqual(["new name.md"]);
  });

  it("reconciles deletions, restorations, and files dropped into the directory", async () => {
    const test = await spaceForTest();
    const imported = await test.files.importFile({
      sourceKind: "manual-upload",
      sourceKey: "upload:reconcile",
      originalName: "keep.md",
      workspaceId: test.spaceId,
      buffer: Buffer.from("# keep", "utf8"),
    });
    const kept = join(test.root, "keep.md");

    // 用户在访达里删掉它，又往目录里扔了一个新文件。
    await unlink(kept);
    await writeFile(join(test.root, "dropped.md"), "# dropped", "utf8");

    const report = await reconcileSpaceLibrary({
      db: test.db,
      writer: test.writer,
      files: test.files,
      spaceId: test.spaceId,
    });
    expect(report.missing).toEqual(["keep.md"]);
    expect(report.added).toEqual(["dropped.md"]);
    expect(stateOf(test.db, imported.fileEntryId)).toBe("missing");

    const dropped = test.files.listCatalog(50, 0, { workspaceId: test.spaceId }).items
      .find((item) => item.originalName === "dropped.md");
    expect(dropped).toBeTruthy();
    expect(dropped?.relativePath).toBe("dropped.md");
    expect(dropped?.sourceLabel).toContain("手动上传");

    // 文件回来了 → 恢复。
    await writeFile(kept, "# keep", "utf8");
    const restored = await reconcileSpaceLibrary({
      db: test.db,
      writer: test.writer,
      files: test.files,
      spaceId: test.spaceId,
    });
    expect(restored.restored).toEqual(["keep.md"]);
    expect(stateOf(test.db, imported.fileEntryId)).not.toBe("missing");
  });

  it("backfills legacy entries that only exist in the object store", async () => {
    const test = await spaceForTest();
    const imported = await test.files.importFile({
      sourceKind: "manual-upload",
      sourceKey: "upload:legacy",
      originalName: "legacy.md",
      workspaceId: test.spaceId,
      buffer: Buffer.from("# legacy", "utf8"),
    });
    // 模拟迁移前的老条目：盘上没有文件、relativePath 为空。
    await unlink(join(test.root, "legacy.md"));
    test.db.update(fileEntries).set({ relativePath: null })
      .where(eq(fileEntries.id, imported.fileEntryId)).run();

    expect(await test.files.backfillLibraryFile(imported.fileEntryId)).toBe(true);
    expect(existsSync(join(test.root, "legacy.md"))).toBe(true);
    expect((await catalogRow(test.files, imported.fileEntryId))?.relativePath).toBe("legacy.md");
  });

  it("keeps local-folder references out of the library directory", async () => {
    const test = await spaceForTest();
    const sourcePath = join(test.dataDir, "external.md");
    await writeFile(sourcePath, "# external", "utf8");
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update("# external", "utf8").digest("hex");
    await test.files.importLocalFileReference({
      sourceKind: "local-folder",
      sourceKey: "local:item:1",
      originalName: "external.md",
      sourcePath,
      contentHash: hash,
      byteSize: Buffer.byteLength("# external"),
      localSourceId: "src",
      localItemId: "item-1",
      workspaceId: test.spaceId,
    });

    const rootEntries = (await readdir(test.root)).filter((name) => !name.startsWith("."));
    expect(rootEntries).toEqual([]);
  });

  it("clamps unsafe file names so they stay inside the library", () => {
    expect(safeLibraryFileName("../escape.md")).toBe("escape.md");
    expect(safeLibraryFileName("a/b\\c.md")).toBe("c.md");
    expect(safeLibraryFileName("  ..hidden  ")).toBe("hidden");
    expect(safeLibraryFileName("")).toBe("file");
    expect(safeLibraryFileName("x".repeat(200) + ".md").length).toBeLessThanOrEqual(120);
  });
});
