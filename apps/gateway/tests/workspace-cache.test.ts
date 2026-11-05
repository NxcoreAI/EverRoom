import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/infrastructure/database/client.js";
import { agentWorkspaces } from "../src/infrastructure/database/schema.js";
import { SpaceCacheManager } from "../src/modules/workspace-layout/cache.js";
import { WorkspaceLayoutService } from "../src/modules/workspace-layout/service.js";

/**
 * 空间缓存（P3）验收：
 * - `withScratch` 落在 `<space>/.tmp/<purpose>/<uuid>`，结束即删；
 * - 未绑目录的空间回落系统临时目录（调用方无需分支）；
 * - `stats` 分项统计 tmp / derived / objects；
 * - `gc` 按龄清 tmp、按引用保留 objects、回收站 30 天清理；
 * - `listScratch` 只读列 `<space>/.tmp`（递归、按 mtime 倒序、上限截断），不入索引。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function cacheForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-space-cache-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const layout = new WorkspaceLayoutService({ dataDir });
  const cache = new SpaceCacheManager(database.db, layout);
  const spaceId = "ws-cache";
  const provisioned = layout.provision({ spaceId, name: "Cache test" });
  database.db.insert(agentWorkspaces).values({
    id: spaceId,
    name: "Cache test",
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
  return { db: database.db, layout, cache, spaceId, root: provisioned.paths.root };
}

async function ageFile(path: string, ageMs: number): Promise<void> {
  const past = new Date(Date.now() - ageMs);
  await utimes(path, past, past);
}

describe("project space cache (P3)", () => {
  it("runs work inside the space scratch directory and cleans it afterwards", async () => {
    const test = await cacheForTest();
    let seen = "";
    await test.cache.withScratch(test.spaceId, "thesis", async (directory) => {
      seen = directory;
      await writeFile(join(directory, "intermediate.docx"), "x", "utf8");
      expect(existsSync(join(directory, "intermediate.docx"))).toBe(true);
      expect(directory.startsWith(join(test.root, ".tmp", "thesis"))).toBe(true);
    });
    expect(existsSync(seen)).toBe(false);
    // 父目录（purpose）保留，只有本次任务的 uuid 目录被删。
    expect(existsSync(join(test.root, ".tmp", "thesis"))).toBe(true);
  });

  it("falls back to the system temp directory when the space has no root", async () => {
    const test = await cacheForTest();
    let seen = "";
    await test.cache.withScratch("ws-unbound", "thesis", async (directory) => {
      seen = directory;
    });
    expect(existsSync(seen)).toBe(false);
    expect(seen.startsWith(join(test.root, ".tmp"))).toBe(false);
  });

  it("reports per-area cache usage", async () => {
    const test = await cacheForTest();
    const tmpFile = join(test.root, ".tmp", "thesis", "blob.bin");
    await mkdir(join(test.root, ".tmp", "thesis"), { recursive: true });
    await writeFile(tmpFile, Buffer.alloc(2048));
    const derivedFile = join(test.root, ".everoffice", "cache", "derived", "preview.png");
    await mkdir(join(test.root, ".everoffice", "cache", "derived"), { recursive: true });
    await writeFile(derivedFile, Buffer.alloc(1024));
    const objectPath = join(test.root, ".everoffice", "objects", "a".repeat(64));
    await mkdir(join(test.root, ".everoffice", "objects"), { recursive: true });
    await writeFile(objectPath, Buffer.alloc(512));

    const stats = await test.cache.stats(test.spaceId);
    expect(stats).toMatchObject({
      bound: true,
      tmpBytes: 2048,
      derivedBytes: 1024,
      objectsBytes: 512,
      totalBytes: 3584,
      tmpFiles: 1,
      derivedFiles: 1,
      objectFiles: 1,
    });
  });

  it("garbage collects stale tmp/derived, keeps referenced objects, and purges old trash", async () => {
    const test = await cacheForTest();
    const cacheRoot = join(test.root, ".everoffice", "cache");
    const tmpRoot = join(test.root, ".tmp");
    const staleTmp = join(tmpRoot, "thesis", "old.bin");
    await mkdir(join(tmpRoot, "thesis"), { recursive: true });
    await writeFile(staleTmp, Buffer.alloc(1024));
    await ageFile(staleTmp, 3 * 24 * 60 * 60 * 1000);

    const freshTmp = join(tmpRoot, "thesis", "fresh.bin");
    await writeFile(freshTmp, Buffer.alloc(64));

    const objectsRoot = join(test.root, ".everoffice", "objects");
    const referenced = "b".repeat(64);
    const unreferenced = "c".repeat(64);
    await mkdir(objectsRoot, { recursive: true });
    await writeFile(join(objectsRoot, referenced), Buffer.alloc(32));
    await writeFile(join(objectsRoot, unreferenced), Buffer.alloc(32));
    await ageFile(join(objectsRoot, referenced), 40 * 24 * 60 * 60 * 1000);
    await ageFile(join(objectsRoot, unreferenced), 40 * 24 * 60 * 60 * 1000);

    const oldTrashDay = join(test.root, ".everoffice", "trash", "20250101");
    const oldTrash = join(oldTrashDay, "bucket-1");
    await mkdir(oldTrash, { recursive: true });
    await writeFile(join(oldTrash, "deleted.docx"), Buffer.alloc(128));
    // gc 按"日期桶"的 mtime 判断，改桶目录的时间。
    await ageFile(oldTrashDay, 40 * 24 * 60 * 60 * 1000);

    const result = await test.cache.gc(test.spaceId, { referencedHashes: new Set([referenced]) });

    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true);
    // 被引用的快照即使超龄也保留；没引用的按龄清掉。
    expect(existsSync(join(objectsRoot, referenced))).toBe(true);
    expect(existsSync(join(objectsRoot, unreferenced))).toBe(false);
    expect(existsSync(oldTrashDay)).toBe(false);
    expect(result.removedTmp).toBe(1);
    expect(result.removedObjects).toBe(1);
    expect(result.purgedTrash).toBe(1);
    expect(result.freedBytes).toBeGreaterThanOrEqual(1024 + 32 + 128);
  });

  it("lists .tmp contents read-only (recursive, newest first, capped)", async () => {
    const test = await cacheForTest();
    const tmpRoot = join(test.root, ".tmp");
    // 造两级嵌套 + 顶层文件，并让 mtime 有先后。
    await mkdir(join(tmpRoot, "thesis", "run-1"), { recursive: true });
    const older = join(tmpRoot, "thesis", "run-1", "preview.png");
    const newer = join(tmpRoot, "thesis", "run-1", "transcript.txt");
    await writeFile(older, Buffer.alloc(100));
    await writeFile(newer, Buffer.alloc(23));
    await ageFile(older, 60 * 60 * 1000);
    const top = join(tmpRoot, "screenshot.jpg");
    await writeFile(top, Buffer.alloc(7));

    const listing = await test.cache.listScratch(test.spaceId);
    expect(listing).toMatchObject({ bound: true, present: true, truncated: false, fileCount: 3 });
    expect(listing.totalBytes).toBe(130);
    // 相对 `.tmp/` 的路径，POSIX 分隔符；按 mtime 倒序（最老的排最后）。
    const paths = listing.entries.map((entry) => entry.path);
    expect(new Set(paths)).toEqual(new Set([
      "screenshot.jpg",
      "thesis/run-1/transcript.txt",
      "thesis/run-1/preview.png",
    ]));
    expect(paths[paths.length - 1]).toBe("thesis/run-1/preview.png");
    // 只读：既不写库，也不改目录。
    expect(existsSync(older)).toBe(true);

    // 未绑定目录：空清单、bound=false。
    const unbound = await test.cache.listScratch("ws-unbound");
    expect(unbound).toMatchObject({ bound: false, present: false, entries: [], fileCount: 0 });

    // 从未产生过临时文件的空间：bound=true、present=false。
    const emptySpace = "ws-empty-scratch";
    const empty = test.layout.provision({ spaceId: emptySpace, name: "Empty scratch" });
    test.db.insert(agentWorkspaces).values({
      id: emptySpace,
      name: "Empty scratch",
      description: null,
      goals: [],
      path: empty.paths.root,
      slug: empty.marker.slug,
      rootMode: "managed",
      layoutVersion: 2,
      kind: "custom",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastOpenedAt: new Date(),
    }).run();
    await rm(join(empty.paths.root, ".tmp"), { recursive: true, force: true });
    expect(await test.cache.listScratch(emptySpace)).toMatchObject({
      bound: true, present: false, entries: [], fileCount: 0,
    });

    // 超过上限：只回前 500 条并标记截断，但 fileCount 仍然是真实总数。
    const many = join(test.root, ".tmp", "bulk");
    await mkdir(many, { recursive: true });
    for (let index = 0; index < 503; index += 1) {
      await writeFile(join(many, `f-${index}.bin`), Buffer.alloc(1));
    }
    const capped = await test.cache.listScratch(test.spaceId);
    expect(capped.truncated).toBe(true);
    // 截断后 fileCount 是下界（扫描在超过上限的第一个文件处停止），UI 显示成 `500+`。
    expect(capped.fileCount).toBe(501);
    expect(capped.entries).toHaveLength(500);
  });

  it("keeps the space root claim and returns nothing for unbound spaces", async () => {
    const test = await cacheForTest();
    const stats = await test.cache.stats("ws-unbound");
    expect(stats.bound).toBe(false);
    expect(stats.totalBytes).toBe(0);
    const gc = await test.cache.gc("ws-unbound");
    expect(gc.removedTmp).toBe(0);
    expect((await stat(test.root)).isDirectory()).toBe(true);
  });
});
