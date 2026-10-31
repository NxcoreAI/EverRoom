import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { FilesService } from "../src/modules/files/service.js";
import { createFileReadPiTool } from "../src/modules/files/pi-tools.js";
import { parsedDocuments } from "../src/infrastructure/database/schema.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

function runInput(activeFile?: StartRuntimeRunInput["activeFile"]): StartRuntimeRunInput {
  return {
    runId: "run-1",
    sessionId: "session-1",
    runtimeSessionRef: null,
    prompt: "这份文档里面是什么东西",
    pageLabel: "Agent",
    roomId: null,
    ...(activeFile ? { activeFile } : {}),
  };
}

describe("file_read 工具", () => {
  function toolWith(overrides: Partial<Parameters<typeof createFileReadPiTool>[0]> = {}) {
    return createFileReadPiTool({
      files: () => ({
        catalogEntry: vi.fn(() => ({
          id: "file-1",
          originalName: "plan.docx",
          displayName: null,
          currentVersionId: "fver-1",
          processingState: "ready",
        })),
        catalogMarkdownOf: vi.fn(() => "# 方案\n\n正文内容"),
        markdownOf: vi.fn(() => null),
      }),
      understanding: () => ({
        markdownForFile: vi.fn(() => null),
        parseVersion: vi.fn(async () => null),
      }),
      ...overrides,
    });
  }

  it("省略 fileId 时读用户当前浏览的文件", async () => {
    const tool = toolWith();
    const result = await tool.execute(
      runInput({ fileId: "file-1", title: "方案.docx", kind: "docx", editable: true }),
      {},
    );
    const payload = JSON.parse(result.content as string);
    expect(payload).toMatchObject({
      fileId: "file-1",
      title: "plan.docx",
      active: true,
      content: "# 方案\n\n正文内容",
      truncated: false,
      source: "saved-version",
    });
  });

  it("显式 fileId 优先于当前文件", async () => {
    const catalogEntry = vi.fn((id: string) => ({
      id,
      originalName: "other.pptx",
      displayName: null,
      currentVersionId: "fver-2",
      processingState: "ready",
    }));
    const tool = toolWith({
      files: () => ({
        catalogEntry,
        catalogMarkdownOf: vi.fn(() => "deck"),
        markdownOf: vi.fn(() => null),
      }),
    });
    const payload = JSON.parse((await tool.execute(
      runInput({ fileId: "file-active", title: "方案.docx", kind: "docx" }),
      { fileId: "file-other" },
    )).content as string);
    expect(catalogEntry).toHaveBeenCalledWith("file-other");
    expect(payload).toMatchObject({ fileId: "file-other", active: false });
  });

  it("没有缓存正文时按当前版本即时解析", async () => {
    const parseVersion = vi.fn(async () => ({ markdown: "即时解析出的正文" }));
    const tool = toolWith({
      files: () => ({
        catalogEntry: vi.fn(() => ({
          id: "file-1",
          originalName: "plan.docx",
          displayName: "Plan",
          currentVersionId: "fver-9",
          processingState: "processing",
        })),
        catalogMarkdownOf: vi.fn(() => null),
        markdownOf: vi.fn(() => null),
      }),
      understanding: () => ({ markdownForFile: vi.fn(() => null), parseVersion }),
    });
    const payload = JSON.parse((await tool.execute(runInput(), { fileId: "file-1" })).content as string);
    expect(parseVersion).toHaveBeenCalledWith("file-1", "fver-9");
    expect(payload.content).toBe("即时解析出的正文");
  });

  it("既没有当前文件也没有 fileId 时给出可执行的错误", async () => {
    const tool = toolWith();
    await expect(tool.execute(runInput(), {})).rejects.toThrow(/NO_ACTIVE_FILE/);
  });

  it("长文按 offset/limit 分页并给出 nextOffset", async () => {
    const markdown = "0123456789".repeat(10);
    const tool = toolWith({
      files: () => ({
        catalogEntry: vi.fn(() => ({
          id: "file-1",
          originalName: "plan.docx",
          displayName: null,
          currentVersionId: "fver-1",
          processingState: "ready",
        })),
        catalogMarkdownOf: vi.fn(() => markdown),
        markdownOf: vi.fn(() => null),
      }),
    });
    const payload = JSON.parse((await tool.execute(runInput(), { fileId: "file-1", offset: 10, limit: 5 })).content as string);
    expect(payload.content).toBe(markdown.slice(10, 15));
    expect(payload.truncated).toBe(true);
    expect(payload.nextOffset).toBe(15);
    expect(payload.totalCharacters).toBe(markdown.length);
  });
});

describe("Office 文件解析结果落库", () => {
  async function catalogForTest() {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-file-read-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const service = new FilesService(database.db, dataDir);
    service.initializeCatalog();
    return { ...database, service, dataDir };
  }

  it("parsed_documents 的 id 不会写进历史外键 parsed_id（否则整次导入 FOREIGN KEY 失败）", async () => {
    const test = await catalogForTest();
    const imported = await test.service.importFile({
      sourceKind: "manual-upload",
      sourceKey: "manual:docx:1",
      originalName: "contract.docx",
      buffer: Buffer.from("fake-docx"),
    });

    // 旧解析管线写 parsed_contents（pc-*），新管线写 parsed_documents（pdoc-*）。
    expect(() => test.service.touchVersionParsed(
      imported.fileEntryId,
      imported.fileVersionId,
      "pdoc-new-pipeline",
    )).not.toThrow();

    const version = test.sqlite.prepare("select parsed_id as parsedId, status from file_versions where id = ?")
      .get(imported.fileVersionId) as { parsedId: string | null; status: string };
    expect(version).toEqual({ parsedId: null, status: "parsed" });
    expect(test.service.catalogEntry(imported.fileEntryId)).toMatchObject({
      id: imported.fileEntryId,
      currentVersionId: imported.fileVersionId,
      parsed: true,
      processingState: "ready",
    });
  });

  it("catalogMarkdownOf 能按当前版本从 parsed_documents 取回正文", async () => {
    const test = await catalogForTest();
    const imported = await test.service.importFile({
      sourceKind: "manual-upload",
      sourceKey: "manual:docx:2",
      originalName: "report.docx",
      buffer: Buffer.from("fake-docx-2"),
    });
    test.db.insert(parsedDocuments).values({
      id: "pdoc-report",
      fileVersionId: imported.fileVersionId,
      parserRevision: "test",
      format: "docx",
      artifact: { document: { fileEntryId: imported.fileEntryId } },
      markdown: "# 报告\n\n这是正文",
      quality: { status: "partial" },
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();

    expect(test.service.catalogMarkdownOf(imported.fileEntryId)).toBe("# 报告\n\n这是正文");
  });

  it("catalogEntry 按 id 直查，目录超过首页长度也不受影响", async () => {
    const test = await catalogForTest();
    const first = await test.service.importFile({
      sourceKind: "manual-upload",
      sourceKey: "manual:md:first",
      originalName: "first.md",
      buffer: Buffer.from("# first"),
    });
    // 造 3 条比 first 更新的条目：旧的实现从 listCatalog(200) 里找仍能找到，
    // 但直查语义对超大目录（>200）才真正兜住；这里断言键值命中不依赖排序。
    for (let index = 0; index < 3; index += 1) {
      await test.service.importFile({
        sourceKind: "manual-upload",
        sourceKey: `manual:md:newer-${index}`,
        originalName: `newer-${index}.md`,
        buffer: Buffer.from(`# newer ${index}`),
      });
    }
    expect(test.service.catalogEntry(first.fileEntryId)?.originalName).toBe("first.md");
  });
});
