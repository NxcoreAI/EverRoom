import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  contentHashOf,
  fileIdOf,
  storageRelPath,
} from "../src/modules/files/storage.js";
import { titleOfFilename } from "../src/modules/knowledge/file-convert.js";
import { KnowledgeService } from "../src/modules/knowledge/service.js";
import { FilesService } from "../src/modules/files/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  // Windows：sqlite -shm 释放有延迟，EBUSY 时让 fs.rm 自带的重试兜底
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

/** 真实 sqlite（临时目录）+ 临时 dataDir 的服务实例；不 start()，避免 worker 干扰。 */
async function serviceForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-knowledge-files-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new KnowledgeService(
    db,
    {
      baseUrl: "http://127.0.0.1:9", // 不可达即可：测试只验证读取面，不触 KS
      serviceId: "everroom",
      teamId: "everroom",
      dataDir,
      roomWikisEnabled: false,
      ingestDebounceMs: 600_000,
      routerEnabled: true,
      entityPromoteScore: 2.0,
      entityPromoteSources: 2,
      mergeAutoDice: 0.75,
      mergeJudgeDice: 0.6,
      llm: null,
      embeddingLlm: null,
      embeddingModel: "",
    },
    { info: () => {}, warn: () => {}, error: () => {} },
  );
  return {
    service,
    files: new FilesService(db, dataDir),
    dataDir,
    sqlite,
    count: (sql: string, ...params: unknown[]) =>
      (sqlite.prepare(sql).all(...params) as unknown[]).length,
    rows: <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

describe("文件名 → 信封标题（M3b）", () => {
  it("标题取文件名去扩展名", () => {
    expect(titleOfFilename("Q3营销方案.md")).toBe("Q3营销方案");
    expect(titleOfFilename("notes.markdown")).toBe("notes");
  });

  it("标题剥路径分隔符并限长", () => {
    expect(titleOfFilename("a/b\\c.md")).toBe("a-b-c");
    expect(titleOfFilename(".md")).toBe("未命名文件");
    expect(titleOfFilename(`${"长".repeat(300)}.md`)).toHaveLength(200);
  });
});

describe("文件读取面与归属清单（资料模型修订）", () => {
  it("markdown 预览、本体绝对路径、Room 文件清单 join 决策状态", async () => {
    const test = await serviceForTest();
    const fileId = fileIdOf("极核资料.md");
    const parsedId = test.files.ensureParsed(
      contentHashOf(Buffer.from("# 极核\n\n正文", "utf8")),
      "# 极核\n\n正文",
    );
    await test.files.upload({ filename: "极核资料.md", buffer: Buffer.from("# 极核\n\n正文", "utf8") });
    test.files.touchParsed(fileId, parsedId);

    expect(test.service.readFileMarkdown(fileId)).toBe("# 极核\n\n正文");
    expect(await readFile(test.service.fileStoragePath(fileId)!, "utf8")).toBe("# 极核\n\n正文");

    // 人工落一条归属决策 → listRoomFiles 应能看到该文件及其状态
    test.sqlite.prepare(
      "INSERT INTO route_decisions (id, source_kind, source_id, source_version, source_title, primary_room_id, confidence, decided_by, status, created_at, updated_at) VALUES (?, 'file', ?, 1, ?, 'room-1', 0.9, 'llm', 'auto', 1, 1)",
    ).run("d1", fileId, "极核资料");
    const files = test.service.listRoomFiles("room-1");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      id: fileId,
      originalName: "极核资料.md",
      status: "auto",
      decidedBy: "llm",
    });
    test.sqlite.close();
  });

  it("listRoomFiles 多对多并集：mention 链接派生的归属也进对应 Room 清单", async () => {
    const test = await serviceForTest();
    test.service.upsertRoom({ id: "room-a", title: "项目甲" });
    test.service.upsertRoom({ id: "room-b", title: "人物乙" });
    // 两个 Room 的户口实体均经 ED4 种子化为已晋升（entity_id 确定性）
    const fileId = fileIdOf("项目甲周报.md");
    await test.files.upload({ filename: "项目甲周报.md", buffer: Buffer.from("# 周报\n\n张三（人物乙）负责排期", "utf8") });

    // 主房 room-a 已确认沉淀；room-b 无 primary_room_id 落点，只有 mention 链接
    test.sqlite.prepare(
      "INSERT INTO route_decisions (id, source_kind, source_id, source_version, source_title, primary_room_id, confidence, decided_by, status, created_at, updated_at) VALUES (?, 'file', ?, 1, ?, 'room-a', 1, 'resolution', 'confirmed', 1, 1)",
    ).run("d-multi", fileId, "项目甲周报");
    const insertLink = test.sqlite.prepare(
      "INSERT INTO entity_doc_links (id, entity_id, source_kind, source_id, source_version, role, salience, decided_by, created_at, updated_at) VALUES (?, ?, 'file', ?, 1, ?, ?, 'resolution', 1, 1)",
    );
    insertLink.run("l-1", "ent-room-room-a", fileId, "primary", 0.9);
    insertLink.run("l-2", "ent-room-room-b", fileId, "mention", 0.3);

    // a 源（primary_room_id 直接归属）与 b 源（mention 链接派生）都能看到
    expect(test.service.listRoomFiles("room-a").map((file) => file.id)).toContain(fileId);
    expect(test.service.listRoomFiles("room-b").map((file) => file.id)).toContain(fileId);

    // 只链接 room-b 的文件不外溢进 room-a；未链接的房（room 无关实体）看不到
    const soloId = fileIdOf("人物乙访谈.md");
    await test.files.upload({ filename: "人物乙访谈.md", buffer: Buffer.from("# 访谈", "utf8") });
    test.sqlite.prepare(
      "INSERT INTO route_decisions (id, source_kind, source_id, source_version, source_title, primary_room_id, confidence, decided_by, status, created_at, updated_at) VALUES (?, 'file', ?, 1, ?, NULL, 1, 'resolution', 'linked', 1, 1)",
    ).run("d-solo", soloId, "人物乙访谈");
    insertLink.run("l-3", "ent-room-room-b", soloId, "primary", 0.8);
    expect(test.service.listRoomFiles("room-a").map((file) => file.id)).not.toContain(soloId);
    expect(test.service.listRoomFiles("room-b").map((file) => file.id)).toContain(soloId);
    test.sqlite.close();
  });

  it("统一导入管线的目录文件（file_entries）进清单并读 markdown/本体", async () => {
    const test = await serviceForTest();
    const imported = await test.files.importFile({
      sourceKind: "manual-upload",
      sourceKey: "manual:catalog-1",
      originalName: "编程学习文档.docx",
      buffer: Buffer.from("docx 字节", "utf8"),
    });
    // 目录文件只在 file_entries 落账，uploaded_files 无记录
    expect(test.count("SELECT * FROM uploaded_files WHERE id = ?", imported.fileEntryId)).toBe(0);

    // 人工落归属决策 → listRoomFiles 应能从目录表补齐元信息
    test.sqlite.prepare(
      "INSERT INTO route_decisions (id, source_kind, source_id, source_version, source_title, primary_room_id, confidence, decided_by, status, created_at, updated_at) VALUES (?, 'file', ?, 1, ?, 'room-cat', 1, 'resolution', 'confirmed', 1, 1)",
    ).run("d-cat", imported.fileEntryId, "编程学习文档");
    const files = test.service.listRoomFiles("room-cat");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      id: imported.fileEntryId,
      originalName: "编程学习文档.docx",
      bytes: Buffer.byteLength("docx 字节"),
    });

    // 模拟解析完成：parsed 产物挂上版本后 markdown 与本体路径走 catalog 分支
    const parsedId = test.files.ensureParsed(imported.contentHash, "# 编程学习文档");
    test.sqlite.prepare("UPDATE file_versions SET parsed_id = ?, status = 'parsed' WHERE id = ?")
      .run(parsedId, imported.fileVersionId);
    test.sqlite.prepare("UPDATE file_entries SET state = 'ready' WHERE id = ?")
      .run(imported.fileEntryId);
    expect(test.service.readFileMarkdown(imported.fileEntryId)).toBe("# 编程学习文档");
    await expect(readFile(test.service.fileStoragePath(imported.fileEntryId)!, "utf8"))
      .resolves.toBe("docx 字节");

    // 软删除的目录文件不再进清单
    test.sqlite.prepare("UPDATE file_entries SET deleted_at = 1 WHERE id = ?").run(imported.fileEntryId);
    expect(test.service.listRoomFiles("room-cat")).toHaveLength(0);
    test.sqlite.close();
  });

  it("存量回填：旧随机 sourceId 决策迁移到确定性身份并落对象库", async () => {
    const test = await serviceForTest();
    test.sqlite.prepare(
      "INSERT INTO route_decisions (id, source_kind, source_id, source_version, source_title, source_markdown, primary_room_id, confidence, decided_by, status, created_at, updated_at) VALUES (?, 'file', 'file-legacyrand', 1, ?, ?, 'room-9', 0.8, 'llm', 'confirmed', 1, 1)",
    ).run("d-old", "旧资料", "# 旧资料\n\n存量快照");

    test.service.start(); // roomWikisEnabled=false：只触发回填，不起 worker
    const deadline = Date.now() + 5_000;
    for (;;) {
      if (test.count("SELECT * FROM gateway_metadata WHERE key = 'knowledge.files_backfill_v1'") > 0) break;
      if (Date.now() > deadline) throw new Error("backfill flag not written in time");
      await delay(50);
    }

    const deterministicId = fileIdOf("旧资料.md");
    expect(test.rows<{ source_id: string }>(
      "SELECT source_id FROM route_decisions WHERE id = 'd-old'",
    )[0]!.source_id).toBe(deterministicId);
    const file = test.rows<{ content_hash: string; original_name: string }>(
      "SELECT content_hash, original_name FROM uploaded_files WHERE id = ?",
      deterministicId,
    )[0]!;
    expect(file.original_name).toBe("旧资料.md");
    // 本体字节进对象库（快照 markdown 的 sha256）
    const expected = contentHashOf(Buffer.from("# 旧资料\n\n存量快照", "utf8"));
    expect(file.content_hash).toBe(expected);
    expect(await readFile(join(test.dataDir, storageRelPath(expected)), "utf8")).toBe("# 旧资料\n\n存量快照");

    // 二次启动不重复迁移
    test.service.start();
    await delay(200);
    expect(test.count("SELECT * FROM gateway_metadata WHERE key = 'knowledge.files_backfill_v1'")).toBe(1);
    test.service.dispose();
    test.sqlite.close();
  });
});
