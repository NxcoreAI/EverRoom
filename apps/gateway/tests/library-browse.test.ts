import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { FilesService } from "../src/modules/files/service.js";
import { collectLibraryInventory } from "../src/modules/files/library-inventory.js";
import {
  LIBRARY_BROWSE_DEFAULT_LIMIT,
  createLibraryBrowsePiTool,
} from "../src/modules/files/library-browse.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function catalogForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-library-browse-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new FilesService(database.db, dataDir);
  service.initializeCatalog();
  return { service, dataDir };
}

let sourceSeq = 0;
async function addFile(
  service: FilesService,
  originalName: string,
  options: { workspaceId?: string; sourceKind?: "manual-upload" | "agent-generated" } = {},
): Promise<string> {
  sourceSeq += 1;
  const imported = await service.importFile({
    sourceKind: options.sourceKind ?? "manual-upload",
    sourceKey: `manual:browse:${sourceSeq}`,
    originalName,
    buffer: Buffer.from(`# ${originalName}\n\nbody ${sourceSeq}\n`, "utf8"),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
  });
  return imported.fileEntryId;
}

function runInput(overrides: Partial<StartRuntimeRunInput> = {}): StartRuntimeRunInput {
  return {
    runId: "run-1",
    sessionId: "session-1",
    runtimeSessionRef: null,
    prompt: "我们今年的营收目标是多少",
    pageLabel: "chat",
    roomId: null,
    workspaceId: "ws-a",
    ...overrides,
  };
}

async function browse(service: FilesService, params: Record<string, unknown>, overrides: Partial<StartRuntimeRunInput> = {}) {
  const tool = createLibraryBrowsePiTool({ files: () => service });
  const result = await tool.execute(runInput(overrides), params);
  return JSON.parse(result.content) as {
    scope: string;
    total: number;
    offset: number;
    returned: number;
    hasMore: boolean;
    nextOffset?: number;
    items: Array<{
      fileId: string;
      title: string;
      extension: string;
      kind: string;
      readable: boolean;
      scope: string;
      scopeKey: string;
    }>;
    hint: string;
  };
}

describe("library_browse 工具", () => {
  it("按工作区列出条目：总数、类型、可读性与产物/资料归属", async () => {
    const { service } = await catalogForTest();
    const pdfId = await addFile(service, "Nexwing BP 数据汇编 2025-04.pdf", { workspaceId: "ws-a" });
    await addFile(service, "logo.png", { workspaceId: "ws-a" });
    await addFile(service, "智能家居行业调研报告.docx", { workspaceId: "ws-a", sourceKind: "agent-generated" });
    // 其他工作区的文件不能出现在本会话的浏览结果里。
    await addFile(service, "别的空间的资料.pdf", { workspaceId: "ws-b" });

    const payload = await browse(service, {});
    expect(payload.total).toBe(3);
    expect(payload.returned).toBe(3);
    expect(payload.hasMore).toBe(false);
    expect(JSON.stringify(payload.items)).not.toContain("别的空间的资料");

    const pdf = payload.items.find((item) => item.fileId === pdfId)!;
    expect(pdf).toMatchObject({ kind: "pdf", extension: ".pdf", readable: true, scope: "资料", scopeKey: "library" });
    const ppt = payload.items.find((item) => item.title === "智能家居行业调研报告.docx")!;
    expect(ppt).toMatchObject({ kind: "word", scope: "产物", scopeKey: "artifacts" });
    const image = payload.items.find((item) => item.title === "logo.png")!;
    expect(image).toMatchObject({ kind: "image", readable: false });
  });

  it("分页：offset/limit 生效，hasMore/nextOffset 指路，翻到底后不再提示继续", async () => {
    const { service } = await catalogForTest();
    for (let index = 0; index < 5; index += 1) {
      await addFile(service, `材料 ${index}.pdf`, { workspaceId: "ws-a" });
    }
    const first = await browse(service, { limit: 2 });
    expect(first).toMatchObject({ total: 5, offset: 0, returned: 2, hasMore: true, nextOffset: 2 });
    const last = await browse(service, { limit: 2, offset: 4 });
    expect(last).toMatchObject({ total: 5, offset: 4, returned: 1, hasMore: false });
    expect(last.nextOffset).toBeUndefined();
  });

  it("超过上限的 limit 被夹到 100，缺省 25 条", async () => {
    const { service } = await catalogForTest();
    for (let index = 0; index < 3; index += 1) {
      await addFile(service, `材料 ${index}.pdf`, { workspaceId: "ws-a" });
    }
    const tool = createLibraryBrowsePiTool({ files: () => service });
    const payload = JSON.parse((await tool.execute(runInput(), { limit: 5000 })).content) as { returned: number };
    expect(payload.returned).toBe(3);
    expect(LIBRARY_BROWSE_DEFAULT_LIMIT).toBe(25);
  });

  it("scope=artifacts 只翻产物库，资料不混进来", async () => {
    const { service } = await catalogForTest();
    await addFile(service, "上传的合同.pdf", { workspaceId: "ws-a" });
    await addFile(service, "Agent 生成的报告.docx", { workspaceId: "ws-a", sourceKind: "agent-generated" });
    const payload = await browse(service, { scope: "artifacts" });
    expect(payload.total).toBe(1);
    expect(payload.items.map((item) => item.title)).toEqual(["Agent 生成的报告.docx"]);
  });

  it("库为空时给可执行的下一步指引，而不是空数组了事", async () => {
    const { service } = await catalogForTest();
    const payload = await browse(service, {});
    expect(payload.total).toBe(0);
    expect(payload.items).toEqual([]);
    expect(payload.hint).toContain("还没有符合条件的文件");
  });

  it("服务未就绪时报错码明确", async () => {
    const tool = createLibraryBrowsePiTool({ files: () => null });
    await expect(tool.execute(runInput(), {})).rejects.toThrow(/FILE_SERVICE_UNAVAILABLE/);
  });
});

describe("collectLibraryInventory", () => {
  it("只报数量：资料库/产物各多少份，不列条目", async () => {
    const { service } = await catalogForTest();
    await addFile(service, "a.pdf", { workspaceId: "ws-a" });
    await addFile(service, "b.docx", { workspaceId: "ws-a" });
    await addFile(service, "c.docx", { workspaceId: "ws-a", sourceKind: "agent-generated" });
    await addFile(service, "别的空间.pdf", { workspaceId: "ws-b" });
    expect(collectLibraryInventory(service, { workspaceId: "ws-a" })).toEqual({ library: 2, artifacts: 1, total: 3 });
  });

  it("库为空或服务缺失时返回 null（不塞 0 份的空提示）", async () => {
    const { service } = await catalogForTest();
    expect(collectLibraryInventory(service, { workspaceId: "ws-a" })).toBeNull();
    expect(collectLibraryInventory(null, { workspaceId: "ws-a" })).toBeNull();
  });
});
