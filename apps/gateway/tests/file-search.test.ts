import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { fileEntries } from "../src/infrastructure/database/schema.js";
import { FilesService } from "../src/modules/files/service.js";
import { createFileSearchPiTool } from "../src/modules/files/pi-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function catalogForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-file-search-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new FilesService(database.db, dataDir);
  service.initializeCatalog();
  return { ...database, service, dataDir };
}

let sourceSeq = 0;
async function addFile(
  service: FilesService,
  originalName: string,
  options: { workspaceId?: string; content?: string } = {},
): Promise<string> {
  sourceSeq += 1;
  const imported = await service.importFile({
    sourceKind: "manual-upload",
    sourceKey: `manual:search:${sourceSeq}`,
    originalName,
    buffer: Buffer.from(options.content ?? `# ${originalName}\n\nbody ${sourceSeq}\n`, "utf8"),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
  });
  return imported.fileEntryId;
}

function runInput(overrides: Partial<StartRuntimeRunInput> = {}): StartRuntimeRunInput {
  return {
    runId: "run-1",
    sessionId: "session-1",
    runtimeSessionRef: null,
    prompt: "找一下那份报告",
    pageLabel: "chat",
    roomId: null,
    workspaceId: "ws-run",
    ...overrides,
  };
}

describe("FilesService.searchCatalog", () => {
  it("按文件名子串搜索，同时匹配原始文件名与显示名", async () => {
    const test = await catalogForTest();
    const reportId = await addFile(test.service, "智能家居行业调研报告.md");
    await addFile(test.service, "季度预算.md");

    const byName = test.service.searchCatalog("智能家居");
    expect(byName.total).toBe(1);
    expect(byName.items.map((item) => item.id)).toEqual([reportId]);
    expect(byName.items[0]!.originalName).toBe("智能家居行业调研报告.md");

    // 子串命中（不是前缀匹配）。
    expect(test.service.searchCatalog("调研").total).toBe(1);
    expect(test.service.searchCatalog("预算").total).toBe(1);
    expect(test.service.searchCatalog("不存在的名字").total).toBe(0);

    // 重命名后的显示名也参与匹配。
    test.service.renameCatalogEntry(reportId, "智能家居 2026 终稿");
    const byDisplayName = test.service.searchCatalog("终稿");
    expect(byDisplayName.total).toBe(1);
    expect(byDisplayName.items[0]!.displayName).toBe("智能家居 2026 终稿");
  });

  it("按扩展名过滤（.docx / docx / 大写都接受）", async () => {
    const test = await catalogForTest();
    await addFile(test.service, "报告.md");
    const txtId = await addFile(test.service, "备注.txt");

    expect(test.service.searchCatalog("", { extensions: ["txt"] }).items.map((item) => item.id)).toEqual([txtId]);
    expect(test.service.searchCatalog("", { extensions: [".TXT"] }).items.map((item) => item.id)).toEqual([txtId]);
    expect(test.service.searchCatalog("", { extensions: [".md"] }).items.map((item) => item.originalName)).toEqual(["报告.md"]);
    const both = test.service.searchCatalog("", { extensions: ["md", "txt"] });
    expect(both.total).toBe(2);
  });

  it("工作区过滤：未传 = 全库；显式传只出该工作区（NULL 归属按 default）", async () => {
    const test = await catalogForTest();
    await addFile(test.service, "默认空间报告.md");
    const wsA = await addFile(test.service, "A空间报告.md", { workspaceId: "ws-a" });

    expect(test.service.searchCatalog("报告").total).toBe(2);
    const scoped = test.service.searchCatalog("报告", { workspaceId: "ws-a" });
    expect(scoped.items.map((item) => item.id)).toEqual([wsA]);
    expect(scoped.items[0]!.workspaceId).toBe("ws-a");
    // 显式传 default 时命中 NULL 归属的存量行（与 listCatalog 同口径）。
    expect(test.service.searchCatalog("报告", { workspaceId: "default" }).total).toBe(1);
    // 空串按 default 归一，不是"全库"。
    expect(test.service.searchCatalog("报告", { workspaceId: "  " }).total).toBe(1);
  });

  it("排除已删除条目", async () => {
    const test = await catalogForTest();
    const id = await addFile(test.service, "待删除报告.md");
    expect(test.service.searchCatalog("待删除").total).toBe(1);
    test.db.update(fileEntries).set({ deletedAt: new Date() }).where(eq(fileEntries.id, id)).run();
    expect(test.service.searchCatalog("待删除").total).toBe(0);
  });

  it("按更新时间倒序，limit/offset 分页且 total 不受分页影响", async () => {
    const test = await catalogForTest();
    const ids = [
      await addFile(test.service, "报告一.md"),
      await addFile(test.service, "报告二.md"),
      await addFile(test.service, "报告三.md"),
    ];
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    ids.forEach((id, index) => {
      test.db.update(fileEntries).set({ updatedAt: new Date(base + index * 1_000) })
        .where(eq(fileEntries.id, id)).run();
    });

    const page1 = test.service.searchCatalog("报告", { limit: 2 });
    expect(page1.total).toBe(3);
    expect(page1.items.map((item) => item.originalName)).toEqual(["报告三.md", "报告二.md"]);

    const page2 = test.service.searchCatalog("报告", { limit: 2, offset: 2 });
    expect(page2.total).toBe(3);
    expect(page2.items.map((item) => item.originalName)).toEqual(["报告一.md"]);

    // limit 越界收敛到 1..100（防止模型传 10000 把上下文撑爆）。
    expect(test.service.searchCatalog("报告", { limit: 10_000 }).items.length).toBe(3);
    expect(test.service.searchCatalog("报告", { limit: 0 }).items.length).toBe(1);
  });
});

interface SearchOptions {
  extensions?: readonly string[];
  workspaceId?: string;
  limit?: number;
  offset?: number;
}

interface SearchHit {
  id: string;
  originalName: string;
  displayName: string | null;
  workspaceId: string;
  updatedAt: string;
  dataType: string | null;
}

type SearchCatalogStub = Mock<(
  query: string,
  options?: SearchOptions,
) => { total: number; items: SearchHit[] }>;

describe("file_search pi 工具", () => {
  function toolWith(searchCatalog: SearchCatalogStub) {
    return createFileSearchPiTool({ files: () => ({ searchCatalog }) });
  }

  it("透传 query/extension/workspace/limit，返回 fileId + 文件名 + 时间 + 归属", async () => {
    const searchCatalog: SearchCatalogStub = vi.fn((_query: string, _options?: SearchOptions) => ({
      total: 1,
      items: [{
        id: "fe-9",
        originalName: "智能家居行业调研报告.docx",
        displayName: "调研报告",
        workspaceId: "ws-run",
        updatedAt: "2026-10-30T10:00:00.000Z",
        dataType: "office-doc",
      }],
    }));
    const result = await toolWith(searchCatalog).execute(
      runInput(),
      { query: "调研报告", extension: "docx", limit: 5 },
    );

    expect(searchCatalog).toHaveBeenCalledOnce();
    expect(searchCatalog.mock.calls[0]).toEqual([
      "调研报告",
      { extensions: ["docx"], workspaceId: "ws-run", limit: 5 },
    ]);
    const payload = JSON.parse(result.content) as {
      total: number;
      items: Array<Record<string, unknown>>;
    };
    expect(payload.total).toBe(1);
    expect(payload.items[0]).toMatchObject({
      fileId: "fe-9",
      originalName: "智能家居行业调研报告.docx",
      displayName: "调研报告",
      extension: ".docx",
      kind: "word",
      workspaceId: "ws-run",
      updatedAt: "2026-10-30T10:00:00.000Z",
    });
    expect((result.details as { returned: number }).returned).toBe(1);
  });

  it("extension 可传数组（用户说“刚上传的 logo/图片”时 agent 会传多个扩展名）", async () => {
    const searchCatalog: SearchCatalogStub = vi.fn(() => ({ total: 0, items: [] }));
    await toolWith(searchCatalog).execute(runInput(), {
      query: "logo",
      extension: ["png", "jpg", "jpeg"],
    });
    expect(searchCatalog.mock.calls[0]).toEqual([
      "logo",
      { extensions: ["png", "jpg", "jpeg"], workspaceId: "ws-run", limit: 10 },
    ]);
  });

  it("params.workspaceId 覆盖运行会话工作区；limit 缺省 10、越界收敛 50", async () => {
    const searchCatalog: SearchCatalogStub = vi.fn((_query: string, _options?: SearchOptions) => ({
      total: 0,
      items: [],
    }));
    const tool = toolWith(searchCatalog);

    await tool.execute(runInput(), { query: "x", workspaceId: "ws-explicit" });
    expect(searchCatalog.mock.calls[0]![1]).toMatchObject({ workspaceId: "ws-explicit", limit: 10 });

    await tool.execute(runInput(), { query: "x", limit: 999 });
    expect(searchCatalog.mock.calls[1]![1]).toMatchObject({ limit: 50 });

    // 运行会话没有工作区时不做工作区过滤（全库搜索）。
    await tool.execute(runInput({ workspaceId: null }), { query: "x" });
    expect(searchCatalog.mock.calls[2]![1]).not.toHaveProperty("workspaceId");
  });

  it("空查询 + 空结果给可执行提示，而不是报错", async () => {
    const result = await toolWith(vi.fn((_query: string, _options?: SearchOptions) => ({ total: 0, items: [] })))
      .execute(runInput(), { query: "找不到" });
    const payload = JSON.parse(result.content) as { total: number; items: unknown[]; hint: string };
    expect(payload.total).toBe(0);
    expect(payload.items).toEqual([]);
    expect(payload.hint).toContain("换个关键词");
  });

  it("文件服务未就绪时报 FILE_SERVICE_UNAVAILABLE", async () => {
    const tool = createFileSearchPiTool({ files: () => null });
    await expect(tool.execute(runInput(), { query: "x" }))
      .rejects.toThrow(/FILE_SERVICE_UNAVAILABLE/);
  });
});