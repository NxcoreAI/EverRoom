import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { FilesService } from "../src/modules/files/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function serviceForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-files-revert-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new FilesService(database.db, dataDir);
  service.initializeCatalog();
  return { ...database, service, dataDir };
}

describe("listVersions / revertToVersion", () => {
  it("回滚到旧版本：currentVersionId 指回既有版本行，不产生新版本号", async () => {
    const test = await serviceForTest();
    const v1 = await test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:rev:1", originalName: "cover.docx",
      buffer: Buffer.from("color-badge"),
    });
    const v2 = await test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:rev:1", originalName: "cover.docx",
      buffer: Buffer.from("grayscale-badge"), fileEntryId: v1.fileEntryId,
    });
    expect(v2.versionDeduped).toBe(false);

    // 回滚到 v1：判重分支应把 currentVersionId 指回 v1 的版本行（版本号不增）。
    const reverted = await test.service.revertToVersion(v1.fileEntryId, 1);
    expect(reverted).toMatchObject({ versionNo: 1, alreadyCurrent: false, contentHash: v1.contentHash });

    const entry = test.sqlite
      .prepare("SELECT current_version_id FROM file_entries WHERE id = ?")
      .get(v1.fileEntryId) as { current_version_id: string };
    expect(entry.current_version_id).toBe(v1.fileVersionId);

    // 版本链没有第 3 版：回滚是重指，不是追加。
    const count = test.sqlite
      .prepare("SELECT count(*) AS n FROM file_versions WHERE file_entry_id = ?")
      .get(v1.fileEntryId) as { n: number };
    expect(count.n).toBe(2);

    // 当前内容读出来就是 v1 的字节（彩色校徽回来了）。
    const content = await test.service.catalogContentOf(v1.fileEntryId);
    expect(content?.buffer.toString()).toBe("color-badge");
    test.sqlite.close();
  });

  it("回滚当前版是幂等空操作；再滚回去（往返）也不丢历史", async () => {
    const test = await serviceForTest();
    const v1 = await test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:rev:2", originalName: "a.docx",
      buffer: Buffer.from("original"),
    });
    await test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:rev:2", originalName: "a.docx",
      buffer: Buffer.from("edited"), fileEntryId: v1.fileEntryId,
    });
    // 回到 v1，再滚回 v2：两个方向的字节都还在。
    await test.service.revertToVersion(v1.fileEntryId, 1);
    const forward = await test.service.revertToVersion(v1.fileEntryId, 2);
    expect(forward?.alreadyCurrent).toBe(false);
    const content = await test.service.catalogContentOf(v1.fileEntryId);
    expect(content?.buffer.toString()).toBe("edited");
    // 目标即当前版：alreadyCurrent = true，不动库。
    const idempotent = await test.service.revertToVersion(v1.fileEntryId, 2);
    expect(idempotent).toMatchObject({ versionNo: 2, alreadyCurrent: true });
    test.sqlite.close();
  });

  it("listVersions 倒序并标记当前版；不存在的条目/版本号安全返回", async () => {
    const test = await serviceForTest();
    const v1 = await test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:rev:3", originalName: "b.docx",
      buffer: Buffer.from("one"),
    });
    const v2 = await test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:rev:3", originalName: "b.docx",
      buffer: Buffer.from("two"), fileEntryId: v1.fileEntryId,
    });
    const versions = test.service.listVersions(v1.fileEntryId);
    expect(versions.map((v) => v.versionNo)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ current: true, contentHash: v2.contentHash });
    expect(versions[1]).toMatchObject({ current: false, contentHash: v1.contentHash });
    expect(versions[0]!.byteSize).toBe(3);

    expect(test.service.listVersions("file-nonexistent")).toEqual([]);
    await expect(test.service.revertToVersion(v1.fileEntryId, 99)).resolves.toBeNull();
    await expect(test.service.revertToVersion("file-nonexistent", 1)).resolves.toBeNull();
    test.sqlite.close();
  });
});
