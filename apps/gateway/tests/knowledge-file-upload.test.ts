import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  contentHashOf,
  fileIdOf,
  storageRelPath,
} from "../src/modules/knowledge/file-storage.js";
import {
  convertUploadedFile,
  FileConvertError,
  MARKDOWN_CAP_BYTES,
  titleOfFilename,
} from "../src/modules/knowledge/file-convert.js";
import { KnowledgeService } from "../src/modules/knowledge/service.js";

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
      baseUrl: "http://127.0.0.1:9", // 不可达即可：测试只验证入库判重，不触 KS
      serviceId: "everroom",
      teamId: "everroom",
      dataDir,
      roomWikisEnabled: false,
      ingestDebounceMs: 600_000,
      routerEnabled: true,
      routeThresholdAuto: 0.8,
      routeThresholdReview: 0.6,
      autoCreateRoomEnabled: false,
      llm: null,
      embeddingLlm: null,
      embeddingModel: "",
    },
    { info: () => {}, warn: () => {}, error: () => {} },
  );
  return {
    service,
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

describe("文件上传转换（M3b）", () => {
  it("md 原样透传，标题取文件名去扩展名", () => {
    const result = convertUploadedFile("Q3营销方案.md", Buffer.from("# 标题\n\n正文", "utf8"));
    expect(result.title).toBe("Q3营销方案");
    expect(result.markdown).toBe("# 标题\n\n正文");
  });

  it("markdown 扩展名变体同受支持", () => {
    const result = convertUploadedFile("notes.markdown", Buffer.from("hello", "utf8"));
    expect(result.title).toBe("notes");
    expect(result.markdown).toBe("hello");
  });

  it("非 md 格式明确拒绝（首期仅支持 .md）", () => {
    for (const filename of ["报告.docx", "发票.pdf", "readme.txt", "无扩展名"]) {
      expect(() => convertUploadedFile(filename, Buffer.from("x", "utf8")))
        .toThrowError(FileConvertError);
    }
    try {
      convertUploadedFile("报告.docx", Buffer.from("x", "utf8"));
      expect.unreachable();
    } catch (error) {
      expect((error as FileConvertError).code).toBe("unsupported_type");
    }
  });

  it("空内容文件拒绝", () => {
    expect(() => convertUploadedFile("空.md", Buffer.alloc(0)))
      .toThrowError(/文件内容为空/);
    expect(() => convertUploadedFile("空白.md", Buffer.from("  \n ", "utf8")))
      .toThrowError(/文件内容为空/);
  });

  it("超限内容截断到 512KB 并附标注（对齐 KS 单文件上限）", () => {
    const big = "# t\n" + "很长的内容".repeat(200_000);
    const result = convertUploadedFile("大文件.md", Buffer.from(big, "utf8"));
    expect(Buffer.byteLength(result.markdown, "utf8")).toBeLessThanOrEqual(MARKDOWN_CAP_BYTES);
    expect(result.markdown).toContain("已截断");
    // 截断不产生半个字符（替换符）
    expect(result.markdown).not.toContain("�");
  });

  it("标题剥路径分隔符并限长", () => {
    expect(titleOfFilename("a/b\\c.md")).toBe("a-b-c");
    expect(titleOfFilename(".md")).toBe("未命名文件");
    expect(titleOfFilename(`${"长".repeat(300)}.md`)).toHaveLength(200);
  });
});

describe("上传判重闸门（资料模型修订）", () => {
  it("闸1：同名同内容重传全跳过——不存对象、不入队、无新解析", async () => {
    const test = await serviceForTest();
    const buffer = Buffer.from("# 方案\n\n第一版", "utf8");

    const first = await test.service.submitFileUpload({ filename: "Q3方案.md", buffer });
    expect(first).toMatchObject({ queued: true, deduped: false, sourceId: fileIdOf("Q3方案.md") });

    const again = await test.service.submitFileUpload({ filename: "Q3方案.md", buffer });
    expect(again).toMatchObject({ queued: false, deduped: true, sourceId: first.sourceId });

    expect(test.count("SELECT * FROM uploaded_files")).toBe(1);
    expect(test.count("SELECT * FROM parsed_contents")).toBe(1);
    expect(test.count("SELECT * FROM jobs WHERE type = 'knowledge.route'")).toBe(1);
    test.sqlite.close();
  });

  it("闸2 + 版本更新：同名新内容复用身份，hash 各自入解析表，路由版本递增", async () => {
    const test = await serviceForTest();

    await test.service.submitFileUpload({ filename: "周报.md", buffer: Buffer.from("v1 内容", "utf8") });
    const second = await test.service.submitFileUpload({ filename: "周报.md", buffer: Buffer.from("v2 改后的内容", "utf8") });
    expect(second).toMatchObject({ queued: true, deduped: false, sourceId: fileIdOf("周报.md") });

    const file = test.rows<{ content_hash: string; storage_path: string; bytes: number }>(
      "SELECT content_hash, storage_path, bytes FROM uploaded_files",
    )[0]!;
    const expectedHash = contentHashOf(Buffer.from("v2 改后的内容", "utf8"));
    expect(file.content_hash).toBe(expectedHash);
    expect(file.storage_path).toBe(storageRelPath(expectedHash));
    expect(test.count("SELECT * FROM uploaded_files")).toBe(1);
    expect(test.count("SELECT * FROM parsed_contents")).toBe(2);

    const payloads = test.rows<{ payload: string }>(
      "SELECT payload FROM jobs WHERE type = 'knowledge.route' ORDER BY created_at",
    ).map((row) => JSON.parse(row.payload) as { sourceVersion: number });
    expect(payloads.map((payload) => payload.sourceVersion)).toEqual([1, 2]);
    test.sqlite.close();
  });

  it("身份键 = 规范化文件名：改名即新文件，路径/大小写差异归并", async () => {
    const test = await serviceForTest();

    await test.service.submitFileUpload({ filename: "A.md", buffer: Buffer.from("a", "utf8") });
    await test.service.submitFileUpload({ filename: "B.md", buffer: Buffer.from("b", "utf8") });
    // 路径不同 + 大小写不同 + 首尾空白不同 → 同一身份（版本更新而非新文件）
    const merged = await test.service.submitFileUpload({
      filename: "C:\\temp\\  a.MD ",
      buffer: Buffer.from("a", "utf8"),
    });
    expect(merged.sourceId).toBe(fileIdOf("A.md"));
    expect(test.count("SELECT * FROM uploaded_files")).toBe(2);
    test.sqlite.close();
  });

  it("读取面：markdown 预览、本体绝对路径、Room 文件清单 join 决策状态", async () => {
    const test = await serviceForTest();
    const upload = await test.service.submitFileUpload({
      filename: "极核资料.md",
      buffer: Buffer.from("# 极核\n\n正文", "utf8"),
    });

    expect(test.service.readFileMarkdown(upload.sourceId)).toBe("# 极核\n\n正文");
    expect(await readFile(test.service.fileStoragePath(upload.sourceId)!, "utf8")).toBe("# 极核\n\n正文");

    // 人工落一条归属决策 → listRoomFiles 应能看到该文件及其状态
    test.sqlite.prepare(
      "INSERT INTO route_decisions (id, source_kind, source_id, source_version, source_title, primary_room_id, confidence, decided_by, status, created_at, updated_at) VALUES (?, 'file', ?, 1, ?, 'room-1', 0.9, 'llm', 'auto', 1, 1)",
    ).run("d1", upload.sourceId, "极核资料");
    const files = test.service.listRoomFiles("room-1");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      id: upload.sourceId,
      originalName: "极核资料.md",
      status: "auto",
      decidedBy: "llm",
    });
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
