import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/infrastructure/database/client.js";
import { FilesService } from "../src/modules/files/service.js";
import { ThesisFormatService } from "../src/modules/thesis-format/service.js";
import type { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";

/**
 * 模版 docx 骨架缓存：v3 模板骨架装订的底稿来源。
 *
 * 为什么必须有这一层：排版时模板字节原来只从「卡片关联的资料区文件」读，
 * 而上传通道的 fileEntryId 是可选的（老卡片更可能是 null）。一旦拿不到，
 * 渲染器就静默回落到 v2「照内容重建」——用户看到的就是表格跑到正文首章、
 * 评价表跑到最后一页。缓存把这条依赖彻底切断。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

/** 被测服务的私有成员（缓存读写不对外暴露，只能这样钉行为）。 */
type CacheAccess = {
  writeTemplateCache(cardId: string, bytes: Buffer): Promise<void>;
  readTemplateDocx(
    cardId: string,
    fileEntryId: string | null | undefined,
    sourceName?: string,
  ): Promise<Buffer | null>;
};

async function serviceForTest(): Promise<{ service: ThesisFormatService; access: CacheAccess; dataDir: string; files: FilesService }> {
  const dataDir = await mkdtemp(join(tmpdir(), "everroom-thesis-cache-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const files = new FilesService(database.db, dataDir);
  files.initializeCatalog();
  const service = new ThesisFormatService({
    db: database.db,
    files,
    orchestrator: {} as unknown as SubagentOrchestrator,
    officeBridge: null,
  });
  return { service, access: service as unknown as CacheAccess, dataDir, files };
}

// 必须是「真 docx」形态（PK 头 + word/document.xml）：读缓存时会做这个校验，
// 以免把「改名的 .doc」当成骨架喂给渲染器。
const DOCX_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]),
  Buffer.from("word/document.xml"),
]);

describe("模版 docx 骨架缓存", () => {
  it("FilesService 暴露数据根目录（缓存与对象库同盘）", async () => {
    const { files, dataDir } = await serviceForTest();
    expect(files.dataDirectory()).toBe(dataDir);
  });

  it("写完缓存后，即使没有 fileEntryId 也能读到模版字节", async () => {
    const { access, dataDir } = await serviceForTest();
    await access.writeTemplateCache("card-1", DOCX_BYTES);

    // 关键回归：fileEntryId 为 null（上传通道拿不到）时，v3 仍然有骨架
    const read = await access.readTemplateDocx("card-1", null);
    expect(read).not.toBeNull();
    expect(Buffer.compare(read!, DOCX_BYTES)).toBe(0);

    // 落在 <dataDir>/thesis-templates/<cardId>.docx
    const onDisk = await readFile(join(dataDir, "thesis-templates", "card-1.docx"));
    expect(Buffer.compare(onDisk, DOCX_BYTES)).toBe(0);
  });

  it("没有缓存也没有 fileEntryId 时返回 null（渲染器据此回落 v2，而不是崩）", async () => {
    const { access } = await serviceForTest();
    expect(await access.readTemplateDocx("missing-card", null)).toBeNull();
  });

  it("资料区文件读不到时返回 null，不让排版整体失败", async () => {
    const { access } = await serviceForTest();
    expect(await access.readTemplateDocx("missing-card", "not-a-real-file-entry")).toBeNull();
  });

  it("缓存按卡片 id 隔离，互不串用", async () => {
    const { access } = await serviceForTest();
    const other = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x09, 0x09]), Buffer.from("word/document.xml")]);
    await access.writeTemplateCache("card-a", DOCX_BYTES);
    await access.writeTemplateCache("card-b", other);

    expect(Buffer.compare((await access.readTemplateDocx("card-a", null))!, DOCX_BYTES)).toBe(0);
    expect(Buffer.compare((await access.readTemplateDocx("card-b", null))!, other)).toBe(0);
  });

  it("删卡时连带清掉骨架缓存", async () => {
    const { service, access, dataDir } = await serviceForTest();
    // 先落一张真卡（removeCard 只在卡存在时返回 true）
    const row = service.cardStore().upsert({
      workspaceId: "ws-1",
      card: { cardMeta: { parsedAt: new Date().toISOString() } } as never,
      sourceFileEntryId: null,
      sourceName: "模版.docx",
    });
    await access.writeTemplateCache(row.id, DOCX_BYTES);

    expect(service.removeCard("ws-1", row.id)).toBe(true);
    // dropTemplateCache 是 fire-and-forget，给它一个微任务窗口
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    await expect(stat(join(dataDir, "thesis-templates", `${row.id}.docx`))).rejects.toThrow();
  });

  it("老卡片丢了 fileEntryId 时，按模版文件名在资料区自愈", async () => {
    // 场景：卡片是缓存机制上线前解析的，sourceFileEntryId 为 null。
    // 不按名字找回模版，v3 就永远拿不到骨架，用户看到的就是错位的 v2 产物。
    const dataDir = await mkdtemp(join(tmpdir(), "everroom-thesis-heal-"));
    temporaryDirectories.push(dataDir);
    const templatePath = join(dataDir, "模版.docx");
    await writeFile(templatePath, DOCX_BYTES);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const files = {
      dataDirectory: () => dataDir,
      catalogEntriesByName: (name: string) => (name === "模版.docx" ? [{ id: "entry-1", originalName: "模版.docx" }] : []),
      catalogEntry: (id: string) => (id === "entry-1" ? { id, originalName: "模版.docx" } : null),
      catalogStoragePathOf: (id: string) => (id === "entry-1" ? templatePath : null),
    } as unknown as FilesService;
    const service = new ThesisFormatService({
      db: database.db,
      files,
      orchestrator: {} as unknown as SubagentOrchestrator,
      officeBridge: null,
    });
    const access = service as unknown as CacheAccess;

    const read = await access.readTemplateDocx("card-heal", null, "模版.docx");
    expect(read).not.toBeNull();
    expect(Buffer.compare(read!, DOCX_BYTES)).toBe(0);
    // 自愈后落缓存，下次排版不必再扫资料区
    const cached = await readFile(join(dataDir, "thesis-templates", "card-heal.docx"));
    expect(Buffer.compare(cached, DOCX_BYTES)).toBe(0);
  });

  it("同名模版有多份时不猜，宁可回落 v2 也不拿错文件", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "everroom-thesis-ambiguous-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const files = {
      dataDirectory: () => dataDir,
      catalogEntriesByName: () => [
        { id: "entry-a", originalName: "模版.docx" },
        { id: "entry-b", originalName: "模版.docx" },
      ],
      catalogEntry: () => null,
      catalogStoragePathOf: () => null,
    } as unknown as FilesService;
    const service = new ThesisFormatService({
      db: database.db,
      files,
      orchestrator: {} as unknown as SubagentOrchestrator,
      officeBridge: null,
    });
    const access = service as unknown as CacheAccess;
    expect(await access.readTemplateDocx("card-ambiguous", null, "模版.docx")).toBeNull();
  });
});
