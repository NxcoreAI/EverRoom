import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { FilesService } from "../src/modules/files/service.js";
import { storageRelPath } from "../src/modules/files/storage.js";
import { filesRoutes } from "../src/modules/files/routes.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function catalogForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-file-catalog-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new FilesService(database.db, dataDir);
  service.initializeCatalog();
  return { ...database, service, dataDir };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error("condition not reached");
}

describe("unified file catalog", () => {
  it("reuses a local-folder entry when the disk path and content still match", async () => {
    const test = await catalogForTest();
    const buffer = Buffer.from("# lookup", "utf8");
    const sourcePath = join(test.dataDir, "lookup.md");
    await writeFile(sourcePath, buffer);
    const hash = createHash("sha256").update(buffer).digest("hex");
    const imported = await test.service.importLocalFileReference({
      sourceKind: "local-folder",
      sourceKey: "local:source:lookup",
      originalName: "lookup.md",
      sourcePath,
      contentHash: hash,
      byteSize: buffer.byteLength,
      localSourceId: "source",
      localItemId: "lookup",
    });

    expect(test.service.findBySourcePath(sourcePath, hash)).toEqual({
      fileEntryId: imported.fileEntryId,
      originalName: "lookup.md",
    });
    // 磁盘内容变了就不要再复用旧条目：交给正常导入走版本链。
    expect(test.service.findBySourcePath(sourcePath, "0".repeat(64))).toBeNull();
    expect(test.service.findBySourcePath(join(test.dataDir, "other.md"), hash)).toBeNull();
  });

  it("keeps updatedAt when a local-folder rescan finds unchanged content", async () => {
    const test = await catalogForTest();
    const buffer = Buffer.from("# stable", "utf8");
    const sourcePath = join(test.dataDir, "stable.md");
    await writeFile(sourcePath, buffer);
    const input = {
      sourceKind: "local-folder" as const,
      sourceKey: "local:source:stable",
      originalName: "stable.md",
      sourcePath,
      contentHash: createHash("sha256").update(buffer).digest("hex"),
      byteSize: buffer.byteLength,
      localSourceId: "source",
      localItemId: "stable",
    };
    const imported = await test.service.importLocalFileReference(input);
    // 模拟上一次扫描留下的旧时间戳：重扫不该把它顶到现在。
    test.sqlite.prepare("UPDATE file_entries SET updated_at = 1000 WHERE id = ?").run(imported.fileEntryId);
    const seenBefore = test.sqlite
      .prepare("SELECT last_seen_at FROM file_entries WHERE id = ?")
      .get(imported.fileEntryId) as { last_seen_at: number | null };

    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    const again = await test.service.importLocalFileReference(input);

    expect(again.fileEntryId).toBe(imported.fileEntryId);
    expect(test.sqlite
      .prepare("SELECT updated_at FROM file_entries WHERE id = ?")
      .get(imported.fileEntryId)).toMatchObject({ updated_at: 1000 });
    const seenAfter = test.sqlite
      .prepare("SELECT last_seen_at FROM file_entries WHERE id = ?")
      .get(imported.fileEntryId) as { last_seen_at: number | null };
    expect(seenAfter.last_seen_at ?? 0).toBeGreaterThan(seenBefore.last_seen_at ?? 0);
    test.sqlite.close();
  });

  it("references local files without retaining an internal original mirror", async () => {
    const test = await catalogForTest();
    const buffer = Buffer.from("# shared", "utf8");
    const sourcePath = join(test.dataDir, "shared.md");
    await writeFile(sourcePath, buffer);
    const first = await test.service.importFile({
      sourceKind: "manual-upload", sourceKey: "manual:1", originalName: "shared.md", buffer,
    });
    const second = await test.service.importLocalFileReference({
      sourceKind: "local-folder", sourceKey: "local:source:item", originalName: "shared.md",
      sourcePath, contentHash: createHash("sha256").update(buffer).digest("hex"), byteSize: buffer.byteLength,
      localSourceId: "source", localItemId: "item",
    });

    expect(first.fileEntryId).not.toBe(second.fileEntryId);
    expect(second.blobDeduped).toBe(false);
    expect(test.service.catalogStoragePathOf(second.fileEntryId)).toBe(sourcePath);
    // The only CAS object belongs to the manual upload; the local projection
    // merely shares its metadata and never creates another mirror.
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM file_entries").get()).toMatchObject({ count: 2 });
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM file_blobs").get()).toMatchObject({ count: 1 });
    test.sqlite.close();
  });

  it("marks a broken local link missing while retaining parsed markdown", async () => {
    const test = await catalogForTest();
    const buffer = Buffer.from("# retained markdown");
    const sourcePath = join(test.dataDir, "draft.md");
    await writeFile(sourcePath, buffer);
    const imported = await test.service.importLocalFileReference({
      sourceKind: "local-folder", sourceKey: "local:s:i", originalName: "draft.md", sourcePath,
      contentHash: createHash("sha256").update(buffer).digest("hex"), byteSize: buffer.byteLength,
      localSourceId: "s", localItemId: "i",
    });
    expect(imported.contentHash).toBe(createHash("sha256").update(buffer).digest("hex"));
    await expect(readFile(join(test.dataDir, storageRelPath(imported.contentHash)))).rejects.toThrow();
    const parsedId = test.service.ensureParsed(imported.contentHash, buffer.toString("utf8"), "markdown@1");
    test.service.touchVersionParsed(imported.fileEntryId, imported.fileVersionId, parsedId);
    await rm(sourcePath);

    expect(test.service.catalogStoragePathOf(imported.fileEntryId)).toBeNull();
    expect(test.service.catalogMarkdownOf(imported.fileEntryId)).toBe("# retained markdown");
    expect(test.service.listCatalog().items[0]).toMatchObject({ processingState: "missing", parsed: true });
    test.sqlite.close();
  });

  it("recovers a running file job and disposes only after its worker settles", async () => {
    const test = await catalogForTest();
    const imported = await test.service.importFile({
      sourceKind: "manual-upload", sourceKey: "manual:recover", originalName: "recover.md", buffer: Buffer.from("body"),
    });
    test.sqlite.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(imported.jobId);
    test.service.initializeCatalog();
    let release!: () => void;
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
    const parsedId = test.service.ensureParsed(imported.contentHash, "body", "markdown@1");
    const ingestor = vi.fn(async () => {
      await blocked;
      return { eventId: "event-1", parsedId, dataType: "document" };
    });
    test.service.setVersionIngestor(ingestor);
    await waitFor(() => ingestor.mock.calls.length === 1);
    const disposing = test.service.dispose();
    let disposed = false;
    void disposing.then(() => { disposed = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(disposed).toBe(false);
    release();
    await disposing;
    expect(test.sqlite.prepare("SELECT status FROM jobs WHERE id = ?").get(imported.jobId)).toMatchObject({ status: "completed" });
    test.sqlite.close();
  });

  it("exposes one capability registry and filters unsupported formats", async () => {
    const test = await catalogForTest();
    const extensions = test.service.capabilities().map((item) => item.extension);
    expect(extensions).toContain(".docx");
    expect(extensions).toContain(".doc");
    expect(extensions).toContain(".docm");
    expect(extensions).toContain(".xls");
    expect(extensions).toContain(".xlsm");
    expect(extensions).toContain(".ppt");
    expect(extensions).toContain(".pptm");
    expect(extensions).toContain(".pdf");
    // .odt 自 958bd342 起重新入库（legacy-word-text 解析，供 Agent 读当前阅览文档），
    // 这里只保留「真正不该进库」的 JSON 守卫。
    expect(extensions).not.toContain(".json");
    await expect(test.service.importFile({
      sourceKind: "manual-upload", sourceKey: "manual:json", originalName: "ignored.json", buffer: Buffer.from("{}"),
    })).rejects.toThrow("JSON 文件不会进入文件库");
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM file_entries").get()).toMatchObject({ count: 0 });
    test.sqlite.close();
  });

  it("accepts the streaming multipart import contract", async () => {
    const test = await catalogForTest();
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await app.register(filesRoutes(test.service));
    const form = new FormData();
    form.append("metadata", JSON.stringify({
      sourceKind: "manual-upload", sourceKey: "manual:multipart", originalName: "stream.md",
    }));
    form.append("file", new Blob(["# streamed"]), "stream.md");
    const response = await app.inject({ method: "POST", url: "/v1/file-imports", payload: form });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ versionDeduped: false });
    expect(test.service.listCatalog()).toMatchObject({ total: 1 });
    await app.close();
    await test.service.dispose();
    test.sqlite.close();
  });


  it("listCatalog 检索词下推：扫描窗口外的老文件仍能按名命中", async () => {
    const test = await catalogForTest();
    const target = await test.service.importFile({
      sourceKind: "manual-upload", sourceKey: "manual:bp1020", originalName: "锥光 BP-1020.md",
      buffer: Buffer.from("# bp"), deferIngest: true,
    });
    test.sqlite.prepare("UPDATE file_entries SET updated_at = 1000 WHERE id = ?").run(target.fileEntryId);
    for (let index = 0; index < 600; index += 1) {
      await test.service.importFile({
        sourceKind: "manual-upload", sourceKey: `manual:filler:${index}`, originalName: "filler.md",
        buffer: Buffer.from("filler"), deferIngest: true,
      });
    }
    // workspace_files_list 对「锥光BP-1020」展开出的模式（token + CJK 段窗，无 ASCII 噪声窗）。
    const patterns = ["锥光bp-1020", "锥光"];
    expect(test.service.listCatalog(30, 0, patterns).items.map((item) => item.originalName))
      .toEqual(["锥光 BP-1020.md"]);
    // 无检索词仍是默认分页：只回最新一页，老文件不在其中（行为不变）。
    expect(test.service.listCatalog(30, 0).items.some((item) => item.id === target.fileEntryId)).toBe(false);
    await test.service.dispose();
    test.sqlite.close();
  });

  it("catalogEntry 目录超过一页时仍能按 id 命中（分页兜底）", async () => {
    const test = await catalogForTest();
    const deep = {
      id: "file-deep", originalName: "deep.pptx", displayName: null, sharedTitle: "deep.pptx",
      sourceKind: "agent-generated", sourceLabel: "Agent 生成", relativePath: null, provider: null,
      bytes: 1, dataType: "slides", agentCategory: null, summary: null, tags: [],
      processingState: "ready", clusterId: null, contentHash: "a".repeat(64), currentVersionId: null,
      parsed: false, updatedAt: new Date().toISOString(),
    } as never;
    const pages = new Map<number, { items: never[]; total: number }>([
      [0, { items: [], total: 250 }],
      [200, { items: [deep], total: 250 }],
    ]);
    vi.spyOn(test.service, "listCatalog").mockImplementation(((limit = 100, offset = 0) => (
      pages.get(offset) ?? { items: [], total: 250 }
    )) as never);
    expect(test.service.catalogEntry("file-deep")).toMatchObject({ id: "file-deep", originalName: "deep.pptx" });
    expect(test.service.catalogEntry("file-missing")).toBeNull();
    await test.service.dispose();
    test.sqlite.close();
  });

  it("accepts artifact-imported office uploads as a first-class source kind", async () => {
    const test = await catalogForTest();
    const imported = await test.service.importFileStream({
      sourceKind: "artifact-imported", sourceKey: "artifact:path:case1", originalName: "方案.docx",
      stream: Readable.from([Buffer.from("PK\u0003\u0004 stub")]),
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      roomId: "room-1", pipelines: { room: true, wiki: false },
    });
    expect(imported.fileEntryId).toBeTruthy();
    // 目录回读带出来源与标签（产物导入），渲染端产物库按该 kind 分流。
    expect(test.service.catalogEntry(imported.fileEntryId)).toMatchObject({
      sourceKind: "artifact-imported",
      sourceLabel: "产物导入",
      originalName: "方案.docx",
    });
    // 同 sourceKey 重导入命中同一 entry（版本链），不铸新条目。
    const again = await test.service.importFileStream({
      sourceKind: "artifact-imported", sourceKey: "artifact:path:case1", originalName: "方案.docx",
      stream: Readable.from([Buffer.from("PK\u0003\u0004 v2")]),
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      roomId: "room-1", pipelines: { room: true, wiki: false },
    });
    expect(again.fileEntryId).toBe(imported.fileEntryId);
    expect(again.versionDeduped).toBe(false);
    await test.service.dispose();
    test.sqlite.close();
  });
});
