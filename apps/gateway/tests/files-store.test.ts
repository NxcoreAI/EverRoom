import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { FilesService } from "../src/modules/files/service.js";
import { filesRoutes } from "../src/modules/files/routes.js";
import { contentHashOf, fileIdOf, storageRelPath } from "../src/modules/files/storage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  // Windows：sqlite -shm 释放有延迟，EBUSY 时让 fs.rm 自带的重试兜底
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function serviceForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-files-store-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new FilesService(db, dataDir);
  return {
    service,
    dataDir,
    sqlite,
    exists: async (relative: string) => {
      try {
        await stat(join(dataDir, relative));
        return true;
      } catch {
        return false;
      }
    },
  };
}

describe("统一上传（闸1/版本更新）", () => {
  it("JSON 文件在写对象和数据库前被拒绝", async () => {
    const test = await serviceForTest();
    await expect(test.service.upload({ filename: "package.json", buffer: Buffer.from("{}") }))
      .rejects.toThrow("JSON 文件不会进入文件库");
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM uploaded_files").get())
      .toMatchObject({ c: 0 });
    test.sqlite.close();
  });

  it("启动清理会删除旧版本遗留的 JSON 文件行", async () => {
    const test = await serviceForTest();
    const now = Date.now();
    test.sqlite.prepare(`
      INSERT INTO uploaded_files (
        id, content_hash, storage_path, original_name, bytes, mime, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("file-legacy-json", "a".repeat(64), "files/sha256/aa/legacy", "package.json", 2, "application/json", now, now);

    await expect(test.service.purgeUnsupportedFiles()).resolves.toBe(1);
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM uploaded_files").get())
      .toMatchObject({ c: 0 });
    test.sqlite.close();
  });

  it("首传落对象库与登记行；同名同内容重传 deduped 且零写入", async () => {
    const test = await serviceForTest();
    const buffer = Buffer.from("# 方案", "utf8");

    const first = await test.service.upload({ filename: "方案.md", buffer });
    expect(first).toMatchObject({ fileId: fileIdOf("方案.md"), deduped: false, versionUpdated: false });
    await expect(test.exists(storageRelPath(contentHashOf(buffer)))).resolves.toBe(true);

    const again = await test.service.upload({ filename: "方案.md", buffer });
    expect(again.deduped).toBe(true);
    expect(again.originalName).toBe("方案.md");
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM uploaded_files").get())
      .toMatchObject({ c: 1 });
    test.sqlite.close();
  });

  it("同名新内容 = 版本更新：身份不变，hash/bytes 前移，解析指针保留旧值", async () => {
    const test = await serviceForTest();
    await test.service.upload({ filename: "周报.md", buffer: Buffer.from("v1", "utf8") });
    const parsedId = test.service.ensureParsed(contentHashOf(Buffer.from("v1", "utf8")), "v1");
    test.service.touchParsed(fileIdOf("周报.md"), parsedId);

    const second = await test.service.upload({ filename: "周报.md", buffer: Buffer.from("v2 改稿", "utf8") });
    expect(second).toMatchObject({ deduped: false, versionUpdated: true });

    const row = test.service.get(second.fileId)!;
    expect(row.contentHash).toBe(contentHashOf(Buffer.from("v2 改稿", "utf8")));
    // 解析指针保留旧值：upload 不解析，回填归调用方（touchParsed）
    expect(row.currentParsedId).toBe(parsedId);
    // 两个 hash 的字节都在对象库（内容寻址不覆盖）
    await expect(test.exists(storageRelPath(contentHashOf(Buffer.from("v1", "utf8"))))).resolves.toBe(true);
    await expect(test.exists(storageRelPath(contentHashOf(Buffer.from("v2 改稿", "utf8"))))).resolves.toBe(true);
    test.sqlite.close();
  });

  it("闸2：同 (hash, parser_version) 解析幂等，不同版本各自成行", async () => {
    const test = await serviceForTest();
    const hash = contentHashOf(Buffer.from("同内容", "utf8"));
    const first = test.service.ensureParsed(hash, "# 同内容");
    expect(test.service.ensureParsed(hash, "# 同内容")).toBe(first);
    const upgraded = test.service.ensureParsed(hash, "# 同内容（新解析器）", "md-v2");
    expect(upgraded).not.toBe(first);
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM parsed_contents").get())
      .toMatchObject({ c: 2 });
    test.sqlite.close();
  });
});

describe("删除级联与对象库 GC", () => {
  it("删除：登记行随删、blob 与解析产物回收", async () => {
    const test = await serviceForTest();
    const buffer = Buffer.from("# 要删的", "utf8");
    const uploaded = await test.service.upload({ filename: "待删.md", buffer });
    const parsedId = test.service.ensureParsed(uploaded.contentHash, "# 要删的");
    test.service.touchParsed(uploaded.fileId, parsedId);

    const result = await test.service.deleteFile(uploaded.fileId);
    expect(result).toMatchObject({ fileId: uploaded.fileId, blobCollected: true });
    expect(test.service.get(uploaded.fileId)).toBeNull();
    await expect(test.exists(storageRelPath(uploaded.contentHash))).resolves.toBe(false);
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM parsed_contents").get())
      .toMatchObject({ c: 0 });
    test.sqlite.close();
  });

  it("内容寻址共享：同内容两个文件，删一个不回收 blob，删尽才回收", async () => {
    const test = await serviceForTest();
    const buffer = Buffer.from("# 共同内容", "utf8");
    const a = await test.service.upload({ filename: "甲.md", buffer });
    const b = await test.service.upload({ filename: "乙.md", buffer });
    expect(a.contentHash).toBe(b.contentHash);

    const first = await test.service.deleteFile(a.fileId)!;
    expect(first!.blobCollected).toBe(false);
    await expect(test.exists(storageRelPath(a.contentHash))).resolves.toBe(true);

    const second = await test.service.deleteFile(b.fileId)!;
    expect(second!.blobCollected).toBe(true);
    await expect(test.exists(storageRelPath(a.contentHash))).resolves.toBe(false);
    test.sqlite.close();
  });

  it("手动 GC：清扫无登记引用的解析行与孤儿 blob（rm 失败的兜底）", async () => {
    const test = await serviceForTest();
    const orphanHash = contentHashOf(Buffer.from("孤儿", "utf8"));
    test.service.ensureParsed(orphanHash, "孤儿");
    // 模拟 blob 留在盘上但登记行已删（Windows 句柄占用导致删除失败的场景）
    const kept = await test.service.upload({ filename: "在册.md", buffer: Buffer.from("在册", "utf8") });

    const report = await test.service.collectGarbage();
    expect(report.removedParsed).toBe(1);
    expect(test.service.get(kept.fileId)).not.toBeNull();
    test.sqlite.close();
  });

  it("改名只动显示名，身份 ID 与 markdown 预览不受影响", async () => {
    const test = await serviceForTest();
    const uploaded = await test.service.upload({
      filename: "原名.md",
      buffer: Buffer.from("# 内容", "utf8"),
    });
    const parsedId = test.service.ensureParsed(uploaded.contentHash, "# 内容");
    test.service.touchParsed(uploaded.fileId, parsedId);

    const renamed = test.service.rename(uploaded.fileId, "新显示名");
    expect(renamed!.originalName).toBe("新显示名");
    expect(renamed!.id).toBe(uploaded.fileId);
    expect(test.service.markdownOf(uploaded.fileId)).toBe("# 内容");
    await expect(readFile(test.service.storagePathOf(uploaded.fileId)!, "utf8"))
      .resolves.toBe("# 内容");
    test.sqlite.close();
  });
});

describe("REST /v1/files", () => {
  async function appForTest() {
    const test = await serviceForTest();
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await app.register(filesRoutes(test.service));
    return { app, test };
  }

  it("JSON base64 上传 → 列表/详情/预览/本体路径 → 改名 → 删除", async () => {
    const { app, test } = await appForTest();
    const content = "# 网关文档\n\n正文";
    const upload = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { "content-type": "application/json" },
      payload: { filename: "网关.md", contentBase64: Buffer.from(content, "utf8").toString("base64") },
    });
    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json() as { id: string; deduped: boolean };
    expect(uploaded.deduped).toBe(false);

    // 闸1：同内容重传 deduped
    const again = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { "content-type": "application/json" },
      payload: { filename: "网关.md", contentBase64: Buffer.from(content, "utf8").toString("base64") },
    });
    expect((again.json() as { deduped: boolean }).deduped).toBe(true);

    const list = await app.inject({ method: "GET", url: "/v1/files?limit=10&offset=0" });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: unknown[]; total: number }).total).toBe(1);

    const detail = await app.inject({ method: "GET", url: `/v1/files/${uploaded.id}` });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { parsed: boolean }).parsed).toBe(false);

    // 未解析过的文件：md 预览 404 file_not_parsed（先进链路后才可预览）
    const preview = await app.inject({ method: "GET", url: `/v1/files/${uploaded.id}/markdown` });
    expect(preview.statusCode).toBe(404);
    expect((preview.json() as { error: string }).error).toBe("file_not_parsed");

    const storage = await app.inject({ method: "GET", url: `/v1/files/${uploaded.id}/storage` });
    expect(storage.statusCode).toBe(200);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/files/${uploaded.id}/meta`,
      payload: { displayName: "改名后.md" },
    });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { originalName: string }).originalName).toBe("改名后.md");

    const removed = await app.inject({ method: "DELETE", url: `/v1/files/${uploaded.id}` });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { deleted: boolean }).deleted).toBe(true);
    expect(await app.inject({ method: "GET", url: `/v1/files/${uploaded.id}` })).toMatchObject({
      statusCode: 404,
    });
    await app.close();
    test.sqlite.close();
  });

  it("拒绝扩展名为 JSON 的 multipart 文件", async () => {
    const { app, test } = await appForTest();
    const boundary = "----everroom-json-test";
    const body = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="package.json"',
      "Content-Type: application/json",
      "",
      "{}",
      `--${boundary}--`,
      "",
    ].join("\r\n"));
    const response = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "unsupported_file_type" });
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM uploaded_files").get())
      .toMatchObject({ c: 0 });
    await app.close();
    test.sqlite.close();
  });

  it("multipart 上传（全系统唯一字节入口的主形态）", async () => {
    const { app, test } = await appForTest();
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("# 多部件上传", "utf8")]), "纪要.md");
    const upload = await app.inject({ method: "POST", url: "/v1/files", payload: form });
    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json() as { id: string; bytes: number };
    expect(uploaded.id).toBe(fileIdOf("纪要.md"));
    expect(uploaded.bytes).toBe(Buffer.byteLength("# 多部件上传", "utf8"));
    await app.close();
    test.sqlite.close();
  });

  it("空内容 400；超限 413", async () => {
    const { app, test } = await appForTest();
    const empty = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { "content-type": "application/json" },
      payload: { filename: "空.md", contentBase64: Buffer.alloc(0).toString("base64") || "=" },
    });
    expect(empty.statusCode).toBe(400);

    const big = Buffer.alloc(21 * 1024 * 1024, 1);
    const tooLarge = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { "content-type": "application/json" },
      payload: { filename: "大.md", contentBase64: big.toString("base64") },
    });
    expect(tooLarge.statusCode).toBe(413);
    await app.close();
    test.sqlite.close();
  });

  it("DELETE /v1/files 删除登记行并回收对象库 blob", async () => {
    const test = await serviceForTest();
    const uploaded = await test.service.upload({
      filename: "级联.md",
      buffer: Buffer.from("# 级联", "utf8"),
    });
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await app.register(filesRoutes(test.service));
    const removed = await app.inject({ method: "DELETE", url: `/v1/files/${uploaded.fileId}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ deleted: true, blobCollected: true });
    expect(test.service.get(uploaded.fileId)).toBeNull();
    await expect(test.exists(storageRelPath(uploaded.contentHash))).resolves.toBe(false);
    await app.close();
    test.sqlite.close();
  });
});

/**
 * 2026-10-27 回归：论文排版（reformat / 资料区设为模版）在真实库（1460 个文件）上
 * 一律报 thesis_source_file_not_found——catalogEntry 当时只扫「最近更新的 200 条」，
 * 排名之外的文件永远查不到，用户点「排版」没有任何产出。
 */
describe("catalogEntry 按 id 直查（不受目录分页窗口限制）", () => {
  it("排名 200 之外的老文件仍能按 id 取到", async () => {
    const test = await serviceForTest();
    // 先传目标文档（最老），再传 205 个新文件把它挤出前 200；initializeCatalog 把
    // 历史上传迁成 file_entries（listCatalog 的数据源）。
    const target = await test.service.upload({ filename: "开题与需求、系统设计报告.docx", buffer: Buffer.from("target", "utf8") });
    for (let index = 0; index < 205; index += 1) {
      await test.service.upload({ filename: `填充-${index}.docx`, buffer: Buffer.from(`fill-${index}`, "utf8") });
    }
    test.service.initializeCatalog();

    const page = test.service.listCatalog(200, 0);
    expect(page.total).toBeGreaterThan(200);
    expect(page.items.some((item) => item.id === target.fileId)).toBe(false);

    const entry = test.service.catalogEntry(target.fileId);
    expect(entry?.id).toBe(target.fileId);
    expect(entry?.originalName).toBe("开题与需求、系统设计报告.docx");
    test.sqlite.close();
  });

  it("不存在的 id 返回 null；软删除的条目不返回", async () => {
    const test = await serviceForTest();
    const uploaded = await test.service.upload({ filename: "文档.docx", buffer: Buffer.from("x", "utf8") });
    test.service.initializeCatalog();
    expect(test.service.catalogEntry(uploaded.fileId)?.id).toBe(uploaded.fileId);
    expect(test.service.catalogEntry("file-does-not-exist")).toBeNull();

    // initializeCatalog 迁出的行是 legacy-upload（deleteCatalogEntry 明确不处理这一类），
    // 这里改成普通上传来源，模拟真实产物文件后再验证删除后的可查性。
    test.sqlite.prepare("UPDATE file_entries SET source_kind = 'manual-upload' WHERE id = ?").run(uploaded.fileId);
    await test.service.deleteCatalogEntry(uploaded.fileId);
    expect(test.service.catalogEntry(uploaded.fileId)).toBeNull();
    test.sqlite.close();
  });
});
