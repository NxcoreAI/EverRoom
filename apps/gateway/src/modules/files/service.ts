import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { and, desc, eq, inArray, isNull, like, ne, or, sql } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { sniffImageMime } from "../../infrastructure/image-mime.js";
import { enqueueSearchIndex } from "../search/jobs.js";
import {
  fileBlobs,
  fileClassifications,
  fileEntries,
  fileVersions,
  jobs,
  parsedContents,
  parsedDocuments,
  uploadedFiles,
} from "../../infrastructure/database/schema.js";
import {
  contentHashOf,
  fileIdOf,
  MARKDOWN_PARSER_VERSION,
  storageRelPath,
  storeFileBlob,
  storeFileBlobStream,
} from "./storage.js";
import {
  FILE_FORMAT_CAPABILITIES,
  fileFormatCapability,
  normalizedFileExtension,
} from "./format-registry.js";

export type UploadedFileRow = typeof uploadedFiles.$inferSelect;

export const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  ...FILE_FORMAT_CAPABILITIES.map((item) => item.extension),
  ".gif", ".jpeg", ".jpg", ".png", ".webp",
]);

export function isSupportedUploadFilename(filename: string): boolean {
  return SUPPORTED_UPLOAD_EXTENSIONS.has(normalizedFileExtension(filename));
}

export type FileSourceKind = "manual-upload" | "local-folder" | "connector" | "migration" | "web-clipper" | "legacy-upload" | "agent-generated" | "artifact-imported";

/**
 * 文件默认归属的工作区（与 agent 模块的 default 工作区同一 id，见 0089 迁移）。
 * 未显式传 workspaceId 的入库与 NULL 归属的存量行都按它暴露。
 */
export const DEFAULT_FILE_WORKSPACE_ID = "default";

export interface FileImportInput {
  sourceKind: Exclude<FileSourceKind, "legacy-upload">;
  sourceKey: string;
  originalName: string;
  buffer: Buffer;
  mime?: string | undefined;
  provider?: string | undefined;
  connectionId?: string | undefined;
  localSourceId?: string | undefined;
  localItemId?: string | undefined;
  sourcePath?: string | undefined;
  relativePath?: string | undefined;
  sourceUri?: string | undefined;
  sourceModifiedAt?: Date | undefined;
  pipelines?: { room: boolean; wiki: boolean; memory: boolean } | undefined;
  roomId?: string | undefined;
  /** 归属工作区（资料库/产物库按空间隔离）；缺省归 default。 */
  workspaceId?: string | undefined;
  /** 钉住既有条目（新版本入链）：提供时按 fileEntries.id 定位，忽略 (sourceKind, sourceKey) 分组。 */
  fileEntryId?: string | undefined;
  /** Store a source version without starting normalization/fan-out yet. */
  deferIngest?: boolean | undefined;
}

export type FileImportStreamInput = Omit<FileImportInput, "buffer"> & { stream: Readable };
export type LocalFileReferenceInput = Omit<FileImportInput, "buffer" | "sourceKind" | "localSourceId" | "localItemId"> & {
  sourceKind: "local-folder";
  sourcePath: string;
  contentHash: string;
  byteSize: number;
  localSourceId: string;
  localItemId: string;
};

export interface FileImportResult {
  fileEntryId: string;
  fileVersionId: string;
  jobId: string;
  contentHash: string;
  blobDeduped: boolean;
  versionDeduped: boolean;
}

export interface CatalogFileDto {
  id: string;
  originalName: string;
  displayName: string | null;
  sharedTitle: string;
  sourceKind: FileSourceKind;
  sourceLabel: string;
  relativePath: string | null;
  provider: string | null;
  bytes: number;
  dataType: string | null;
  agentCategory: string | null;
  summary: string | null;
  tags: string[];
  processingState: "processing" | "ready" | "failed" | "missing";
  clusterId: string | null;
  contentHash: string;
  currentVersionId: string | null;
  parsed: boolean;
  /** 归属工作区 id（资料库/产物库按空间过滤）。 */
  workspaceId: string;
  updatedAt: string;
}

/** 解析结果：解析产物 id（无解析器时为空）+ 数据类型。Phase 2 起不再回传 ingest 事件 id。 */
interface VersionIngestResult {
  parsedId: string | null;
  dataType: string;
}

type VersionIngestor = (input: {
  fileEntryId: string;
  fileVersionId: string;
  pipelines?: FileImportInput["pipelines"];
  roomId?: string;
}) => Promise<VersionIngestResult>;
/** 统一上传结果：deduped = 判重闸 1 命中（同名同内容，零写入）。 */
export interface FileUploadResult {
  fileId: string;
  contentHash: string;
  deduped: boolean;
  /** 同名新内容覆盖既有登记行（版本更新语义）。 */
  versionUpdated: boolean;
  bytes: number;
  originalName: string;
}

export interface FileDeletionResult {
  fileId: string;
  /** 对象库 blob 是否被物理回收（被其他文件共享的内容不回收）。 */
  blobCollected: boolean;
}

/**
 * 文件管理中心（unified-ingest-plan §8/U9）：对象库 + uploaded_files +
 * parsed_contents 的唯一所有者。一切字节存取都经它——上传（闸1 判重）、
 * 解析产物（闸2 幂等）、预览、改名、删除级联与对象库 GC。
 */
export class FilesService {
  private versionIngestor: VersionIngestor | null = null;
  private fileJobWorker: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly dataDir: string,
  ) {}

  /**
   * 服务数据根目录。旁路文件（如论文模版 docx 缓存）需要与对象库同盘，
   * 但不属于 catalog 条目，因此单独暴露根路径给需要的模块。
   */
  dataDirectory(): string {
    return this.dataDir;
  }

  /** Backfill the compatibility table without changing any legacy IDs. */
  initializeCatalog(): void {
    const legacyRows = this.db.select().from(uploadedFiles).all();
    for (const row of legacyRows) {
      // 对象库索引全量回填（先于 capability 过滤）：素材检索按 content_hash
      // 内连接 file_blobs，图片等无解析器格式漏行即对检索完全不可见。
      this.db.insert(fileBlobs).values({
        contentHash: row.contentHash,
        storagePath: row.storagePath,
        byteSize: row.bytes,
        mime: row.mime,
        createdAt: row.createdAt,
      }).onConflictDoNothing().run();
      const capability = fileFormatCapability(row.originalName);
      if (!capability) continue;
      const versionId = `fver-legacy-${row.id}`;
      this.db.insert(fileEntries).values({
        id: row.id,
        sourceKind: "legacy-upload",
        sourceKey: `legacy:${row.id}`,
        originalName: row.originalName,
        extension: normalizedFileExtension(row.originalName),
        currentVersionId: versionId,
        state: row.currentParsedId ? "ready" : "processing",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }).onConflictDoNothing().run();
      this.db.insert(fileVersions).values({
        id: versionId,
        fileEntryId: row.id,
        versionNo: 1,
        contentHash: row.contentHash,
        parserId: capability.parserId,
        parserVersion: capability.parserVersion,
        parsedId: row.currentParsedId,
        status: row.currentParsedId ? "parsed" : "stored",
        createdAt: row.createdAt,
        processedAt: row.currentParsedId ? row.updatedAt : null,
      }).onConflictDoNothing().run();
    }
    this.db.update(jobs).set({ status: "pending", updatedAt: new Date() })
      .where(and(eq(jobs.type, "file.ingest"), eq(jobs.status, "running"))).run();
  }

  setVersionIngestor(ingestor: VersionIngestor): void {
    if (this.disposed) throw new Error("FilesService 已关闭");
    this.versionIngestor = ingestor;
    this.kickFileJobs();
  }

  async importFile(input: FileImportInput): Promise<FileImportResult> {
    if (input.sourceKind === "local-folder") throw new Error("本地文件必须使用路径引用入口");
    const capability = this.validateImport(input);
    const stored = await storeFileBlobStream(
      this.dataDir,
      Readable.from(input.buffer),
      capability.maxBytes,
    );
    return this.registerImportedFile(input, stored.contentHash, stored.bytes);
  }

  async importFileStream(input: FileImportStreamInput): Promise<FileImportResult> {
    if (input.sourceKind === "local-folder") throw new Error("本地文件必须使用路径引用入口");
    const capability = this.validateImport(input);
    const stored = await storeFileBlobStream(this.dataDir, input.stream, capability.maxBytes);
    return this.registerImportedFile(input, stored.contentHash, stored.bytes);
  }

  async importLocalFileReference(input: LocalFileReferenceInput): Promise<FileImportResult> {
    this.validateImport(input);
    if (!isAbsolute(input.sourcePath)) throw new Error("本地文件路径必须是绝对路径");
    if (!/^[a-f0-9]{64}$/.test(input.contentHash)) throw new Error("本地文件内容指纹无效");
    const info = await stat(input.sourcePath);
    if (!info.isFile()) throw new Error("本地文件路径不是普通文件");
    if (info.size !== input.byteSize) throw new Error("本地文件在导入过程中发生变化，请稍后重试");
    const currentHash = createHash("sha256").update(await readFile(input.sourcePath)).digest("hex");
    if (currentHash !== input.contentHash) throw new Error("本地文件在导入过程中发生变化，请稍后重试");

    // sourceKey used to contain an inode-based remote id. Preserve the same
    // catalog identity while moving to the stable desktop source-item id.
    const existingLocalEntry = this.db.select().from(fileEntries).where(and(
      eq(fileEntries.sourceKind, "local-folder"),
      eq(fileEntries.localSourceId, input.localSourceId),
      eq(fileEntries.localItemId, input.localItemId),
    )).get();
    if (existingLocalEntry && existingLocalEntry.sourceKey !== input.sourceKey) {
      this.db.update(fileEntries).set({ sourceKey: input.sourceKey }).where(eq(fileEntries.id, existingLocalEntry.id)).run();
    }

    // Keep only hash/size metadata for referential integrity. No bytes are
    // copied into files/sha256 for a local-folder source.
    this.db.insert(fileBlobs).values({
      contentHash: input.contentHash,
      storagePath: storageRelPath(input.contentHash),
      byteSize: input.byteSize,
      mime: input.mime ?? "application/octet-stream",
    }).onConflictDoNothing().run();
    const result = await this.registerImportedFile(input, input.contentHash, input.byteSize);
    const localHashes = this.db.select({ contentHash: fileVersions.contentHash }).from(fileVersions)
      .where(eq(fileVersions.fileEntryId, result.fileEntryId)).all();
    await Promise.all([...new Set(localHashes.map((row) => row.contentHash))]
      .map((hash) => this.collectLocalMirror(hash)));
    return { ...result, blobDeduped: false };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.versionIngestor = null;
    await this.fileJobWorker;
  }

  private validateImport(input: Omit<FileImportInput, "buffer"> | FileImportInput) {
    const capability = fileFormatCapability(input.originalName);
    if (!capability) {
      throw new Error(input.originalName.toLowerCase().endsWith(".json")
        ? "JSON 文件不会进入文件库"
        : `不支持的文件格式：${input.originalName}`);
    }
    if (!input.sourceKey.trim()) throw new Error("sourceKey 不能为空");
    return capability;
  }

  private async registerImportedFile(
    input: Omit<FileImportInput, "buffer"> | LocalFileReferenceInput,
    contentHash: string,
    bytes: number,
  ): Promise<FileImportResult> {
    if (bytes === 0) throw new Error("文件内容为空");
    const capability = fileFormatCapability(input.originalName)!;
    const existingBlob = this.db.select().from(fileBlobs)
      .where(eq(fileBlobs.contentHash, contentHash)).get();
    const now = new Date();
    let entry = input.fileEntryId
      ? this.db.select().from(fileEntries).where(eq(fileEntries.id, input.fileEntryId)).get()
      : this.db.select().from(fileEntries).where(and(
          eq(fileEntries.sourceKind, input.sourceKind),
          eq(fileEntries.sourceKey, input.sourceKey),
        )).get();
    if (input.fileEntryId && !entry) throw new Error("file_entry_not_found");
    // 工作区归属：显式传入（trim 后非空）优先；未传/为空时**保留条目原有归属**，
    // 新条目才落 default。否则编辑保存回填（office edit-sync 按 fileEntryId 重导入）、
    // 本地夹重扫（local-file-references）等不带归属的链路，会把已有文件悄悄改归
    // default —— 用户看到的现象就是「重启后 AI 生成的文件跑去了默认工作区」。
    const workspaceId = input.workspaceId?.trim()
      ?? entry?.workspaceId?.trim()
      ?? DEFAULT_FILE_WORKSPACE_ID;
    const fileEntryId = entry?.id ?? `file-${randomUUID()}`;
    const existingVersion = entry
      ? this.db.select().from(fileVersions).where(and(
          eq(fileVersions.fileEntryId, entry.id),
          eq(fileVersions.contentHash, contentHash),
        )).get()
      : null;

    if (existingVersion) {
      if (!entry) throw new Error("file_entry_not_found");
      const shouldEnqueue = !input.deferIngest
        && (existingVersion.status === "stored" || existingVersion.status === "failed");
      const jobId = this.fileJobId(existingVersion.id, capability.parserId, capability.parserVersion);
      if (shouldEnqueue) {
        const payload = {
          fileEntryId,
          fileVersionId: existingVersion.id,
          attempts: 0,
          ...(input.pipelines ? { pipelines: input.pipelines } : {}),
          ...(input.roomId ? { roomId: input.roomId } : {}),
        };
        this.db.transaction((tx) => {
          tx.update(fileVersions).set({ status: "queued", errorCode: null, errorMessage: null })
            .where(eq(fileVersions.id, existingVersion.id)).run();
          tx.insert(jobs).values({
            id: jobId,
            type: "file.ingest",
            status: "pending",
            payload,
          }).onConflictDoUpdate({
            target: jobs.id,
            set: { status: "pending", payload, result: null, error: null, updatedAt: new Date() },
          }).run();
        });
      }
      const nextState = existingVersion.status === "parsed" ? "ready" : existingVersion.status === "failed" ? "failed" : "processing";
      // 本地夹来源每次应用启动都会把整批文件重新登记一遍（local-file-references）。
      // 内容没变时只刷新 lastSeenAt：如果连 updatedAt 一起顶到 now，文件库/首页按
      // 「最近更新」排序（只取最近 200 条）时，这些没有被改动过的本地文件会反复
      // 挤到最前面，把用户真正上传的文件挤出可见范围——现象就是「重启后我上传的
      // 文件不见了」。
      const metadataChanged = entry.originalName !== input.originalName
        || (input.relativePath !== undefined && entry.relativePath !== input.relativePath)
        || (input.sourcePath !== undefined && entry.sourcePath !== input.sourcePath)
        || (input.sourceUri !== undefined && entry.sourceUri !== input.sourceUri)
        || entry.workspaceId !== workspaceId
        || entry.deletedAt !== null
        || entry.state !== nextState
        || entry.currentVersionId !== existingVersion.id;
      this.db.update(fileEntries).set({
        originalName: input.originalName,
        relativePath: input.relativePath,
        sourcePath: input.sourcePath,
        sourceUri: input.sourceUri,
        // 重新导入会覆盖归属：显式传入 workspaceId 时以最新入口为准。
        workspaceId,
        lastSeenAt: now,
        ...(metadataChanged ? { updatedAt: now } : {}),
        deletedAt: null,
        state: nextState,
        ...(entry?.currentVersionId === existingVersion.id ? {} : { currentVersionId: existingVersion.id }),
      }).where(eq(fileEntries.id, fileEntryId)).run();
      const result: FileImportResult = {
        fileEntryId,
        fileVersionId: existingVersion.id,
        jobId,
        contentHash,
        blobDeduped: Boolean(existingBlob),
        versionDeduped: true,
      };
      if (shouldEnqueue) this.kickFileJobs();
      return result;
    }

    const previousVersions = entry
      ? this.db.select({ versionNo: fileVersions.versionNo }).from(fileVersions)
          .where(eq(fileVersions.fileEntryId, entry.id)).orderBy(desc(fileVersions.versionNo)).limit(1).all()
      : [];
    const versionNo = (previousVersions[0]?.versionNo ?? 0) + 1;
    const fileVersionId = `fver-${randomUUID()}`;
    const jobId = this.fileJobId(fileVersionId, capability.parserId, capability.parserVersion);

    this.db.transaction((tx) => {
      tx.insert(fileBlobs).values({
        contentHash,
        storagePath: storageRelPath(contentHash),
        byteSize: bytes,
        mime: input.mime ?? "application/octet-stream",
      }).onConflictDoNothing().run();
      if (!entry) {
        tx.insert(fileEntries).values({
          id: fileEntryId,
          sourceKind: input.sourceKind,
          sourceKey: input.sourceKey,
          originalName: input.originalName,
          extension: capability.extension,
          provider: input.provider,
          connectionId: input.connectionId,
          localSourceId: input.localSourceId,
          localItemId: input.localItemId,
          sourcePath: input.sourcePath,
          relativePath: input.relativePath,
          sourceUri: input.sourceUri,
          workspaceId,
          currentVersionId: fileVersionId,
          state: "processing",
          lastSeenAt: now,
        }).run();
      } else {
        tx.update(fileEntries).set({
          originalName: input.originalName,
          extension: capability.extension,
          provider: input.provider,
          connectionId: input.connectionId,
          localSourceId: input.localSourceId,
          localItemId: input.localItemId,
          sourcePath: input.sourcePath,
          relativePath: input.relativePath,
          sourceUri: input.sourceUri,
          workspaceId,
          currentVersionId: fileVersionId,
          state: "processing",
          lastSeenAt: now,
          updatedAt: now,
          deletedAt: null,
        }).where(eq(fileEntries.id, fileEntryId)).run();
      }
      tx.insert(fileVersions).values({
        id: fileVersionId,
        fileEntryId,
        versionNo,
        contentHash,
        sourceModifiedAt: input.sourceModifiedAt,
        parserId: capability.parserId,
        parserVersion: capability.parserVersion,
        status: input.deferIngest ? "stored" : "queued",
      }).run();
      if (!input.deferIngest) {
        tx.insert(jobs).values({
          id: jobId,
          type: "file.ingest",
          status: "pending",
          payload: {
            fileEntryId,
            fileVersionId,
            attempts: 0,
            ...(input.pipelines ? { pipelines: input.pipelines } : {}),
            ...(input.roomId ? { roomId: input.roomId } : {}),
          },
        }).run();
      }
    });
    entry = this.db.select().from(fileEntries).where(eq(fileEntries.id, fileEntryId)).get();
    if (!input.deferIngest) this.kickFileJobs();
    // 统一搜索：登记即建 meta（正文等解析完成后再入队补齐）。
    enqueueSearchIndex(this.db, { itemType: "file", refId: fileEntryId, priority: "high" });
    return { fileEntryId, fileVersionId, jobId, contentHash, blobDeduped: Boolean(existingBlob), versionDeduped: false };
  }

  getVersionContext(fileEntryId: string, fileVersionId: string): {
    entry: typeof fileEntries.$inferSelect;
    version: typeof fileVersions.$inferSelect;
    blob: typeof fileBlobs.$inferSelect;
    storagePath: string;
  } | null {
    const entry = this.db.select().from(fileEntries).where(eq(fileEntries.id, fileEntryId)).get();
    const version = this.db.select().from(fileVersions).where(and(
      eq(fileVersions.id, fileVersionId), eq(fileVersions.fileEntryId, fileEntryId),
    )).get();
    if (!entry || !version) return null;
    const blob = this.db.select().from(fileBlobs).where(eq(fileBlobs.contentHash, version.contentHash)).get();
    if (!blob) return null;
    return {
      entry,
      version,
      blob,
      storagePath: entry.sourceKind === "local-folder" && entry.sourcePath
        ? entry.sourcePath
        : join(this.dataDir, blob.storagePath),
    };
  }

  touchVersionParsed(fileEntryId: string, fileVersionId: string, parsedId: string | null): void {
    const now = new Date();
    // parsed_id 的外键指向历史表 parsed_contents；新解析管线落的是
    // parsed_documents（pdoc-*）。把 pdoc id 直接写进 parsed_id 会触发
    // FOREIGN KEY constraint failed，整次导入被判 ingest_failed（Office 文件
    // 因此永远解析不了）。旧表里有同 id 才写，否则置空，正文按 parsed_documents
    // 反查（见 catalogMarkdownOf）。
    const legacyParsedId = parsedId
      ? this.db.select({ id: parsedContents.id }).from(parsedContents)
          .where(eq(parsedContents.id, parsedId)).get()?.id ?? null
      : null;
    this.db.update(fileVersions).set({
      parsedId: legacyParsedId, status: "parsed", errorCode: null, errorMessage: null,
      processedAt: now,
    }).where(and(eq(fileVersions.id, fileVersionId), eq(fileVersions.fileEntryId, fileEntryId))).run();
    const entry = this.db.select().from(fileEntries).where(eq(fileEntries.id, fileEntryId)).get();
    if (entry?.currentVersionId === fileVersionId) {
      this.db.update(fileEntries).set({ state: "ready", updatedAt: now })
        .where(eq(fileEntries.id, fileEntryId)).run();
    }
    enqueueSearchIndex(this.db, { itemType: "file", refId: fileEntryId, priority: "high" });
  }

  /** 目录查询的公共投影：listCatalog（分页）与 catalogEntry（按 id 直查）共用。 */
  private catalogQuery() {
    return this.db.select({
      entry: fileEntries,
      version: fileVersions,
      blob: fileBlobs,
      classification: fileClassifications,
    }).from(fileEntries)
      .leftJoin(fileVersions, eq(fileEntries.currentVersionId, fileVersions.id))
      .leftJoin(fileBlobs, eq(fileVersions.contentHash, fileBlobs.contentHash))
      .leftJoin(fileClassifications, eq(fileVersions.id, fileClassifications.fileVersionId));
  }

  /** 行 → CatalogFileDto（两个入口必须完全同构，否则按 id 直查的字段会与列表不一致）。 */
  private toCatalogFileDto(row: {
    entry: typeof fileEntries.$inferSelect;
    version: typeof fileVersions.$inferSelect | null;
    blob: typeof fileBlobs.$inferSelect | null;
    classification: typeof fileClassifications.$inferSelect | null;
  }): CatalogFileDto {
    const { entry, version, blob, classification } = row;
    return ({
      id: entry.id,
      originalName: entry.originalName,
      displayName: entry.displayName,
      // 聚类（同源多份文件的共享标题）随 file-clusters 退役：一律用条目显示名。
      sharedTitle: entry.displayName ?? entry.originalName,
      sourceKind: entry.sourceKind,
      sourceLabel: entry.provider ?? (entry.sourceKind === "local-folder" ? "本地文件夹" : entry.sourceKind === "manual-upload" ? "手动上传" : entry.sourceKind === "web-clipper" ? "网页剪藏" : entry.sourceKind === "agent-generated" ? "Agent 生成" : entry.sourceKind === "artifact-imported" ? "产物导入" : "历史上传"),
      relativePath: entry.relativePath,
      provider: entry.provider,
      bytes: blob?.byteSize ?? 0,
      dataType: fileFormatCapability(entry.originalName)?.dataType ?? null,
      agentCategory: classification?.category ?? null,
      summary: classification?.summary ?? null,
      tags: classification?.tags ?? [],
      processingState: entry.state === "deleted" ? "missing" : entry.state,
      clusterId: null,
      contentHash: version?.contentHash ?? "",
      currentVersionId: version?.id ?? null,
      parsed: Boolean(version?.parsedId) || version?.status === "parsed",
      workspaceId: entry.workspaceId ?? DEFAULT_FILE_WORKSPACE_ID,
      updatedAt: entry.updatedAt.toISOString(),
    } satisfies CatalogFileDto);
  }

  listCatalog(
    limit = 100,
    offset = 0,
    options: { workspaceId?: string } = {},
  ): { items: CatalogFileDto[]; total: number } {
    // 工作区过滤：未传 = 全库（管理面/主页快照等旧调用不受影响）；
    // 显式传 workspaceId 时，NULL 归属的旧行按 default 匹配（回填前的同语义兜底）。
    const normalizedWorkspace = options.workspaceId === undefined
      ? undefined
      : options.workspaceId.trim() || DEFAULT_FILE_WORKSPACE_ID;
    const workspaceFilter = normalizedWorkspace === undefined
      ? undefined
      : or(
          eq(fileEntries.workspaceId, normalizedWorkspace),
          and(isNull(fileEntries.workspaceId), eq(sql`${normalizedWorkspace}`, sql`${DEFAULT_FILE_WORKSPACE_ID}`)),
        );
    const rows = this.catalogQuery()
      .where(and(isNull(fileEntries.deletedAt), ...(workspaceFilter ? [workspaceFilter] : [])))
      .orderBy(desc(fileEntries.updatedAt)).limit(limit).offset(offset).all();
    const items = rows.map((row) => this.toCatalogFileDto(row));
    const total = this.db.select({ id: fileEntries.id }).from(fileEntries)
      .where(and(isNull(fileEntries.deletedAt), ...(workspaceFilter ? [workspaceFilter] : []))).all().length;
    return { items, total };
  }

  /**
   * 按文件名搜索目录（file_search 工具用）：LIKE 匹配 originalName 与 displayName。
   *
   * 与 listCatalog 同一套工作区口径：未传 workspaceId = 全库；显式传时 NULL 归属的
   * 存量行按 default 匹配。空 query = 按更新时间倒序列出（「最近改过的那份」场景）。
   * 只返回 Windows/macOS 文件名子串可命中的条目，不做全文检索——正文检索走 search 模块。
   */
  searchCatalog(
    query: string,
    options: {
      /** 扩展名过滤（.docx / docx 都接受，大小写不敏感）。 */
      extensions?: readonly string[];
      workspaceId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): { items: CatalogFileDto[]; total: number } {
    const normalizedQuery = query.trim();
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
    const extensions = [...new Set((options.extensions ?? [])
      .map((extension) => extension.trim().toLowerCase())
      .filter((extension) => extension.length > 0)
      .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`)))];
    const normalizedWorkspace = options.workspaceId === undefined
      ? undefined
      : options.workspaceId.trim() || DEFAULT_FILE_WORKSPACE_ID;
    const filters = [isNull(fileEntries.deletedAt)];
    if (normalizedQuery) {
      // SQLite LIKE 对 ASCII 大小写不敏感；中文按子串精确匹配。
      const pattern = `%${normalizedQuery}%`;
      filters.push(or(
        like(fileEntries.originalName, pattern),
        like(fileEntries.displayName, pattern),
      )!);
    }
    if (extensions.length > 0) filters.push(inArray(fileEntries.extension, extensions));
    if (normalizedWorkspace !== undefined) {
      filters.push(or(
        eq(fileEntries.workspaceId, normalizedWorkspace),
        and(isNull(fileEntries.workspaceId), eq(sql`${normalizedWorkspace}`, sql`${DEFAULT_FILE_WORKSPACE_ID}`)),
      )!);
    }
    const where = and(...filters);
    const rows = this.catalogQuery()
      .where(where).orderBy(desc(fileEntries.updatedAt)).limit(limit).offset(offset).all();
    const total = this.db.select({ id: fileEntries.id }).from(fileEntries).where(where).all().length;
    return { items: rows.map((row) => this.toCatalogFileDto(row)), total };
  }

  capabilities() {
    return FILE_FORMAT_CAPABILITIES;
  }

  /**
   * 按磁盘路径 + 当前内容指纹查已有条目：系统文件管理器直接打开文件时，
   * 若该文件已作为「本地文件夹」来源入库且内容未变，直接复用条目打开，
   * 不再把（可能上百 MB 的）文件重新上传一遍，也不产生重复条目。
   */
  findBySourcePath(sourcePath: string, contentHash: string): { fileEntryId: string; originalName: string } | null {
    if (!sourcePath || !/^[a-f0-9]{64}$/.test(contentHash)) return null;
    const row = this.db.select({
      id: fileEntries.id,
      originalName: fileEntries.originalName,
      contentHash: fileVersions.contentHash,
    }).from(fileEntries)
      .innerJoin(fileVersions, eq(fileEntries.currentVersionId, fileVersions.id))
      .where(and(
        eq(fileEntries.sourceKind, "local-folder"),
        eq(fileEntries.sourcePath, sourcePath),
        isNull(fileEntries.deletedAt),
      )).get();
    if (!row || row.contentHash !== contentHash) return null;
    return { fileEntryId: row.id, originalName: row.originalName };
  }

  isCatalogEntry(fileEntryId: string): boolean {
    const entry = this.db.select({ sourceKind: fileEntries.sourceKind }).from(fileEntries)
      .where(eq(fileEntries.id, fileEntryId)).get();
    return Boolean(entry && entry.sourceKind !== "legacy-upload");
  }

  /**
   * 按原始文件名查目录条目。
   *
   * 用于「丢了 id 但文件还在」的自愈场景：论文模版卡片的 sourceFileEntryId 可能
   * 是 null（上传通道拿不到），排版时需要靠文件名把模版 docx 找回来。调用方必须
   * 只在结果唯一时才采用，避免张冠李戴。
   */
  catalogEntriesByName(originalName: string): CatalogFileDto[] {
    return this.catalogQuery()
      .where(and(eq(fileEntries.originalName, originalName), isNull(fileEntries.deletedAt)))
      .all()
      .map((row) => this.toCatalogFileDto(row));
  }

  /** 单个 catalog 条目（@ 文件引用取当前版本 id 用）。 */
  /**
   * 按 id 取单个目录条目。
   *
   * 历史实现是 `listCatalog(200, 0).items.find(...)`——只扫「最近更新的 200 条」。
   * 库大到 1460 个文件后，任何排名 200 之后的文档都查不到：论文排版（reformat /
   * 资料区设为模版）会立刻以 thesis_source_file_not_found 失败，用户看到的就是
   * 「点了排版没反应、不生成任何文件」（2026-10-27 实测：目标文档排名 211）。
   */
  catalogEntry(fileEntryId: string): CatalogFileDto | null {
    // 直接按键查，不再从 listCatalog(200) 里线性找：目录超过 200 条后，
    // 靠后的文件会拿不到条目（@ 引用/当前文件读取都会失败）。
    const row = this.catalogQuery()
      .where(and(eq(fileEntries.id, fileEntryId), isNull(fileEntries.deletedAt)))
      .get();
    return row ? this.toCatalogFileDto(row) : null;
  }

  catalogMarkdownOf(fileEntryId: string): string | null {
    const legacy = this.db.select({ markdown: parsedContents.markdown }).from(fileEntries)
      .innerJoin(fileVersions, eq(fileEntries.currentVersionId, fileVersions.id))
      .innerJoin(parsedContents, eq(fileVersions.parsedId, parsedContents.id))
      .where(eq(fileEntries.id, fileEntryId)).get();
    if (legacy) return legacy.markdown;
    // 现行解析器写 parsed_documents（按 fileVersionId 挂载）；旧 parsed_id 外键
    // 只对历史行有效，这里按当前版本反查，否则 Office 文件正文永远读不到。
    const parsed = this.db.select({ markdown: parsedDocuments.markdown }).from(fileEntries)
      .innerJoin(fileVersions, eq(fileEntries.currentVersionId, fileVersions.id))
      .innerJoin(parsedDocuments, eq(parsedDocuments.fileVersionId, fileVersions.id))
      .where(eq(fileEntries.id, fileEntryId)).get();
    return parsed?.markdown ?? null;
  }

  catalogStoragePathOf(fileEntryId: string): string | null {
    const entry = this.db.select().from(fileEntries).where(eq(fileEntries.id, fileEntryId)).get();
    if (!entry) return null;
    if (entry.sourceKind === "local-folder") {
      if (!entry.sourcePath || !existsSync(entry.sourcePath)) {
        this.db.update(fileEntries).set({ state: "missing", updatedAt: new Date() })
          .where(eq(fileEntries.id, fileEntryId)).run();
        return null;
      }
      return entry.sourcePath;
    }
    const row = this.db.select({ storagePath: fileBlobs.storagePath }).from(fileVersions)
      .innerJoin(fileBlobs, eq(fileVersions.contentHash, fileBlobs.contentHash))
      .where(eq(fileVersions.id, entry.currentVersionId!)).get();
    return row ? join(this.dataDir, row.storagePath) : null;
  }

  async catalogContentOf(fileEntryId: string): Promise<{ buffer: Buffer; mime: string; filename: string } | null> {
    const row = this.db.select({ entry: fileEntries, blob: fileBlobs }).from(fileEntries)
      .innerJoin(fileVersions, eq(fileEntries.currentVersionId, fileVersions.id))
      .innerJoin(fileBlobs, eq(fileVersions.contentHash, fileBlobs.contentHash))
      .where(eq(fileEntries.id, fileEntryId)).get();
    if (!row) return null;
    const path = row.entry.sourceKind === "local-folder" ? row.entry.sourcePath : join(this.dataDir, row.blob.storagePath);
    if (!path || !existsSync(path)) {
      if (row.entry.sourceKind === "local-folder") {
        this.db.update(fileEntries).set({ state: "missing", updatedAt: new Date() })
          .where(eq(fileEntries.id, fileEntryId)).run();
      }
      return null;
    }
    const buffer = await readFile(path);
    // 旧导入的 blob.mime 常为 octet-stream（multipart 未设 type 时期）：图片字节嗅探兜底。
    return { buffer, mime: sniffImageMime(buffer) ?? row.blob.mime, filename: row.entry.originalName };
  }

  async markLocalFileMissing(localSourceId: string, localItemId: string): Promise<boolean> {
    const entry = this.db.select().from(fileEntries).where(and(
      eq(fileEntries.sourceKind, "local-folder"),
      eq(fileEntries.localSourceId, localSourceId),
      eq(fileEntries.localItemId, localItemId),
    )).get();
    if (!entry) return false;
    this.db.update(fileEntries).set({ state: "missing", updatedAt: new Date() })
      .where(eq(fileEntries.id, entry.id)).run();
    const hashes = this.db.select({ contentHash: fileVersions.contentHash }).from(fileVersions)
      .where(eq(fileVersions.fileEntryId, entry.id)).all();
    await Promise.all([...new Set(hashes.map((row) => row.contentHash))].map((hash) => this.collectLocalMirror(hash)));
    return true;
  }

  /**
   * 整源级联清理（桌面端「清空数据源数据」）：按 localSourceId（local-folder/
   * obsidian）或 connector+connectionId（GitHub/GDocs/Notion 导出）锚点收集该源
   * 全部 catalog 条目，逐条目录/对象回收。全步骤幂等。
   */
  async purgeLocalSource(localSourceId: string): Promise<{ entries: number }> {
    const entries = this.db.select({ id: fileEntries.id }).from(fileEntries)
      .where(and(
        isNull(fileEntries.deletedAt),
        or(
          eq(fileEntries.localSourceId, localSourceId),
          and(eq(fileEntries.sourceKind, "connector"), eq(fileEntries.connectionId, localSourceId)),
        ),
      ))
      .all();
    if (entries.length === 0) return { entries: 0 };
    const ids = entries.map((row) => row.id);
    for (const id of ids) await this.deleteCatalogEntry(id);
    return { entries: ids.length };
  }

  renameCatalogEntry(fileEntryId: string, displayName: string): CatalogFileDto | null {
    const normalized = displayName.trim().slice(0, 300);
    if (!normalized) throw new Error("显示名不能为空");
    this.db.update(fileEntries).set({ displayName: normalized, updatedAt: new Date() })
      .where(eq(fileEntries.id, fileEntryId)).run();
    enqueueSearchIndex(this.db, { itemType: "file", refId: fileEntryId, priority: "high" });
    return this.listCatalog(200, 0).items.find((item) => item.id === fileEntryId) ?? null;
  }

  async deleteCatalogEntry(fileEntryId: string): Promise<FileDeletionResult | null> {
    const entry = this.db.select().from(fileEntries).where(eq(fileEntries.id, fileEntryId)).get();
    if (!entry || entry.sourceKind === "legacy-upload") return null;
    const versions = this.db.select().from(fileVersions).where(eq(fileVersions.fileEntryId, fileEntryId)).all();
    this.db.delete(fileEntries).where(eq(fileEntries.id, fileEntryId)).run();
    // 源行已删：worker 重读时移除索引行。
    enqueueSearchIndex(this.db, { itemType: "file", refId: fileEntryId, priority: "high" });
    let blobCollected = false;
    for (const version of versions) {
      const catalogReference = this.db.select({ id: fileVersions.id }).from(fileVersions)
        .where(eq(fileVersions.contentHash, version.contentHash)).limit(1).get();
      const legacyReference = this.db.select({ id: uploadedFiles.id }).from(uploadedFiles)
        .where(eq(uploadedFiles.contentHash, version.contentHash)).limit(1).get();
      if (!catalogReference && !legacyReference) {
        const blob = this.db.select().from(fileBlobs).where(eq(fileBlobs.contentHash, version.contentHash)).get();
        this.db.delete(fileBlobs).where(eq(fileBlobs.contentHash, version.contentHash)).run();
        if (blob) await rm(join(this.dataDir, blob.storagePath), { force: true }).catch(() => undefined);
        blobCollected = true;
      }
      if (version.parsedId) {
        const parsedReference = this.db.select({ id: fileVersions.id }).from(fileVersions)
          .where(eq(fileVersions.parsedId, version.parsedId)).limit(1).get();
        const legacyParsedReference = this.db.select({ id: uploadedFiles.id }).from(uploadedFiles)
          .where(eq(uploadedFiles.currentParsedId, version.parsedId)).limit(1).get();
        if (!parsedReference && !legacyParsedReference) {
          this.db.delete(parsedContents).where(eq(parsedContents.id, version.parsedId)).run();
        }
      }
    }
    if (entry.sourceKind === "local-folder") {
      for (const version of versions) {
        await this.collectLocalMirror(version.contentHash);
      }
    }
    return { fileId: fileEntryId, blobCollected };
  }

  private fileJobId(fileVersionId: string, parserId: string, parserVersion: number): string {
    return `file.ingest:${fileVersionId}:${parserId}@${parserVersion}`;
  }

  private kickFileJobs(): void {
    if (this.disposed || !this.versionIngestor || this.fileJobWorker) return;
    this.fileJobWorker = this.processPendingFileJobs().finally(() => {
      this.fileJobWorker = null;
      if (!this.disposed && this.versionIngestor) {
        const pending = this.db.select({ id: jobs.id }).from(jobs).where(and(
          eq(jobs.type, "file.ingest"), eq(jobs.status, "pending"),
        )).limit(1).get();
        if (pending) this.kickFileJobs();
      }
    });
  }

  private async processPendingFileJobs(): Promise<void> {
    while (!this.disposed && this.versionIngestor) {
        const job = this.db.select().from(jobs).where(and(
          eq(jobs.type, "file.ingest"), eq(jobs.status, "pending"),
        )).orderBy(jobs.createdAt).limit(1).get();
        if (!job) return;
        const payload = job.payload as {
          fileEntryId: string;
          fileVersionId: string;
          attempts?: number;
          pipelines?: FileImportInput["pipelines"];
          roomId?: string;
        };
        const attempts = payload.attempts ?? 0;
        this.db.update(jobs).set({ status: "running", updatedAt: new Date() }).where(eq(jobs.id, job.id)).run();
        this.db.update(fileVersions).set({ status: "parsing", errorCode: null, errorMessage: null })
          .where(eq(fileVersions.id, payload.fileVersionId)).run();
        try {
          const ingestor = this.versionIngestor;
          if (!ingestor) return;
          const result = await ingestor({
            fileEntryId: payload.fileEntryId,
            fileVersionId: payload.fileVersionId,
            ...(payload.pipelines ? { pipelines: payload.pipelines } : {}),
            ...(payload.roomId ? { roomId: payload.roomId } : {}),
          });
          this.touchVersionParsed(payload.fileEntryId, payload.fileVersionId, result.parsedId);
          this.db.update(jobs).set({ status: "completed", result, error: null, updatedAt: new Date() })
            .where(eq(jobs.id, job.id)).run();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempts < 2) {
            this.db.update(jobs).set({
              status: "pending",
              payload: { ...payload, attempts: attempts + 1 },
              error: { message },
              updatedAt: new Date(),
            }).where(eq(jobs.id, job.id)).run();
          } else {
            const now = new Date();
            this.db.update(jobs).set({ status: "failed", error: { message }, updatedAt: now })
              .where(eq(jobs.id, job.id)).run();
            this.db.update(fileVersions).set({
              status: "failed", errorCode: "ingest_failed", errorMessage: message.slice(0, 500), processedAt: now,
            }).where(eq(fileVersions.id, payload.fileVersionId)).run();
            const entry = this.db.select().from(fileEntries).where(eq(fileEntries.id, payload.fileEntryId)).get();
            if (entry?.currentVersionId === payload.fileVersionId) {
              this.db.update(fileEntries).set({ state: "failed", updatedAt: now })
                .where(eq(fileEntries.id, payload.fileEntryId)).run();
            }
          }
        }
    }
  }

  /**
   * 统一上传（全系统唯一字节入口）：
   * 闸1——同身份（确定性 ID）同内容 → deduped，不写对象、不动登记行；
   * 同名新内容 → 版本更新（身份不变，hash/bytes/时间前移，解析指针保留
   * 旧值直到调用方重新解析后 touchParsed）。
   * 注意：这里只管字节与登记，不解析（归一化是理解引擎的职责）。
   */
  /** upload 通道的字节同样登记进对象库索引：素材检索按 content_hash 内连接
   *  file_blobs，图片等无解析器格式漏登记即对检索完全不可见（启动回填也
   *  曾被 capability 过滤挡住）。幂等，已存在时不覆盖。 */
  private ensureBlobRow(contentHash: string, storagePath: string, byteSize: number, mime?: string): void {
    this.db.insert(fileBlobs).values({
      contentHash,
      storagePath,
      byteSize,
      mime: mime ?? "application/octet-stream",
    }).onConflictDoNothing().run();
  }

  async upload(input: {
    filename: string;
    buffer: Buffer;
    mime?: string | undefined;
    assetKind?: "document" | "screenshot" | "photo" | "audio" | "other" | undefined;
    originChannel?: string | undefined;
    visibility?: "private" | "shared" | undefined;
    capturedAt?: Date | undefined;
  }): Promise<FileUploadResult> {
    if (!isSupportedUploadFilename(input.filename)) {
      throw new Error("不支持的文件类型；JSON 文件不会进入文件库");
    }
    const contentHash = contentHashOf(input.buffer);
    const visualIdentity = input.assetKind === "screenshot" || input.assetKind === "photo"
      ? `${input.assetKind}-${contentHash}-${input.filename}`
      : input.filename;
    const fileId = fileIdOf(visualIdentity);

    const existing = this.db.select().from(uploadedFiles).where(eq(uploadedFiles.id, fileId)).get();
    if (existing?.contentHash === contentHash) {
      this.ensureBlobRow(contentHash, existing.storagePath, existing.bytes, input.mime ?? existing.mime);
      if (input.mime || input.assetKind || input.originChannel || input.visibility || input.capturedAt) {
        this.db.update(uploadedFiles).set({
          ...(input.mime ? { mime: input.mime } : {}),
          ...(input.assetKind ? { assetKind: input.assetKind } : {}),
          ...(input.originChannel ? { originChannel: input.originChannel } : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
          updatedAt: new Date(),
        }).where(eq(uploadedFiles.id, fileId)).run();
      }
      return {
        fileId,
        contentHash,
        deduped: true,
        versionUpdated: false,
        bytes: existing.bytes,
        originalName: existing.originalName,
      };
    }

    await storeFileBlob(this.dataDir, contentHash, input.buffer);
    this.ensureBlobRow(contentHash, storageRelPath(contentHash), input.buffer.byteLength, input.mime);
    if (existing) {
      this.db.update(uploadedFiles).set({
        contentHash,
        storagePath: storageRelPath(contentHash),
        originalName: input.filename,
        bytes: input.buffer.byteLength,
        ...(input.mime ? { mime: input.mime } : {}),
        ...(input.assetKind ? { assetKind: input.assetKind } : {}),
        ...(input.originChannel ? { originChannel: input.originChannel } : {}),
        ...(input.visibility ? { visibility: input.visibility } : {}),
        ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
        updatedAt: new Date(),
      }).where(eq(uploadedFiles.id, fileId)).run();
    } else {
      this.db.insert(uploadedFiles).values({
        id: fileId,
        contentHash,
        storagePath: storageRelPath(contentHash),
        originalName: input.filename,
        bytes: input.buffer.byteLength,
        ...(input.mime ? { mime: input.mime } : {}),
        ...(input.assetKind ? { assetKind: input.assetKind } : {}),
        ...(input.originChannel ? { originChannel: input.originChannel } : {}),
        ...(input.visibility ? { visibility: input.visibility } : {}),
        ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
      }).onConflictDoNothing().run();
    }
    return {
      fileId,
      contentHash,
      deduped: false,
      versionUpdated: Boolean(existing),
      bytes: input.buffer.byteLength,
      originalName: input.filename,
    };
  }

  get(fileId: string): UploadedFileRow | null {
    return this.db.select().from(uploadedFiles).where(eq(uploadedFiles.id, fileId)).get() ?? null;
  }

  list(limit = 50, offset = 0): { items: UploadedFileRow[]; total: number } {
    const rows = this.db.select().from(uploadedFiles)
      .orderBy(desc(uploadedFiles.updatedAt))
      .limit(limit)
      .offset(offset)
      .all();
    const total = this.db.select({ id: uploadedFiles.id }).from(uploadedFiles).all().length;
    return { items: rows, total };
  }

  async purgeUnsupportedFiles(): Promise<number> {
    const rows = this.db.select().from(uploadedFiles).all()
      .filter((row) => !isSupportedUploadFilename(row.originalName));
    for (const row of rows) {
      await this.deleteFile(row.id);
    }
    return rows.length;
  }

  /** 文件当前解析产物的 markdown（预览用）；无文件或未解析返回 null。 */
  markdownOf(fileId: string): string | null {
    const file = this.get(fileId);
    if (!file?.currentParsedId) return null;
    const parsed = this.db.select().from(parsedContents)
      .where(eq(parsedContents.id, file.currentParsedId)).get();
    return parsed?.markdown ?? null;
  }

  /** 文件本体的绝对路径（主进程 reveal 用）；无文件返回 null。 */
  storagePathOf(fileId: string): string | null {
    const file = this.get(fileId);
    return file ? join(this.dataDir, file.storagePath) : null;
  }

  async contentOf(fileId: string): Promise<{ buffer: Buffer; mime: string; filename: string } | null> {
    const file = this.get(fileId);
    if (!file) return null;
    return {
      buffer: await readFile(join(this.dataDir, file.storagePath)),
      mime: file.mime,
      filename: file.originalName,
    };
  }

  /** 改显示名（身份 ID 不变——确定性身份在首次上传时定死，aliases 语义）。 */
  rename(fileId: string, displayName: string): UploadedFileRow | null {
    const name = displayName.trim().slice(0, 300);
    if (!name) return null;
    this.db.update(uploadedFiles).set({ originalName: name, updatedAt: new Date() })
      .where(eq(uploadedFiles.id, fileId)).run();
    return this.get(fileId);
  }

  /**
   * 闸2：解析产物幂等入库，(hash, parser_version) 已有则直接复用。
   * 引擎归一化后调用；各类导入路径同样经此落解析。
   */
  ensureParsed(contentHash: string, markdown: string, parserVersion = MARKDOWN_PARSER_VERSION): string {
    const existing = this.db.select().from(parsedContents)
      .where(and(
        eq(parsedContents.contentHash, contentHash),
        eq(parsedContents.parserVersion, parserVersion),
      ))
      .get();
    if (existing) return existing.id;
    const id = `parsed-${randomUUID().slice(0, 12)}`;
    this.db.insert(parsedContents).values({
      id,
      contentHash,
      parserVersion,
      markdown,
    }).run();
    return id;
  }

  /** 解析指针前移（upload 不解析；解析完成后由调用方回填 currentParsedId）。 */
  touchParsed(fileId: string, parsedId: string): void {
    this.db.update(uploadedFiles).set({ currentParsedId: parsedId, updatedAt: new Date() })
      .where(eq(uploadedFiles.id, fileId)).run();
  }

  /**
   * 存量回填登记（一次性迁移用）：快照 markdown 补落对象库 + 解析表 +
   * uploaded_files 行（onConflict 语义，重跑幂等）。blob 写失败返回 null
   * （调用方跳过该行）。
   */
  async registerBackfillFile(input: {
    originalName: string;
    markdown: string;
  }): Promise<{ fileId: string; contentHash: string } | null> {
    const buffer = Buffer.from(input.markdown, "utf8");
    const contentHash = contentHashOf(buffer);
    const fileId = fileIdOf(input.originalName);
    try {
      await storeFileBlob(this.dataDir, contentHash, buffer);
    } catch {
      return null;
    }
    const parsedId = this.ensureParsed(contentHash, input.markdown);
    this.db.insert(uploadedFiles).values({
      id: fileId,
      contentHash,
      storagePath: storageRelPath(contentHash),
      originalName: input.originalName,
      bytes: buffer.byteLength,
      currentParsedId: parsedId,
    }).onConflictDoNothing().run();
    return { fileId, contentHash };
  }

  /**
   * 删除 + 级联清理（§8.2）：登记行随删；parsed_contents 与对象库 blob 仅当
   * 无其他 uploaded_files 行引用同一 hash 时物理回收（内容寻址天然共享）。
   */
  async deleteFile(fileId: string): Promise<FileDeletionResult | null> {
    const file = this.get(fileId);
    if (!file) return null;

    this.db.delete(uploadedFiles).where(eq(uploadedFiles.id, fileId)).run();

    // 内容寻址 GC：同 hash 还有别的文件行引用 → 字节与解析产物保留
    const siblings = this.db.select({ id: uploadedFiles.id }).from(uploadedFiles)
      .where(and(eq(uploadedFiles.contentHash, file.contentHash), ne(uploadedFiles.id, fileId)))
      .all();
    let blobCollected = false;
    if (siblings.length === 0) {
      this.db.delete(parsedContents).where(eq(parsedContents.contentHash, file.contentHash)).run();
      try {
        await rm(join(this.dataDir, file.storagePath), { force: true });
        blobCollected = true;
      } catch {
        // Windows 下句柄占用等瞬时失败：blob 留待手动 GC（collectGarbage）
      }
    }

    return { fileId, blobCollected };
  }

  /**
   * 手动对象库 GC（维护操作）：扫描已无 uploaded_files 引用的 parsed_contents
   * 行与 blob 文件并回收，返回统计。幂等，可重复触发。
   */
  async collectGarbage(): Promise<{ removedParsed: number; removedBlobs: number; errors: number }> {
    const referenced = new Set(
      [
        ...this.db.select({ contentHash: uploadedFiles.contentHash }).from(uploadedFiles).all(),
        ...this.db.select({ contentHash: fileVersions.contentHash }).from(fileVersions).all(),
      ].map((row) => row.contentHash),
    );
    const orphans = this.db.select().from(parsedContents).all()
      .filter((row) => !referenced.has(row.contentHash));
    for (const orphan of orphans) {
      this.db.delete(parsedContents).where(eq(parsedContents.id, orphan.id)).run();
    }
    let removedBlobs = 0;
    let errors = 0;
    const seen = new Set<string>();
    for (const orphan of orphans) {
      if (seen.has(orphan.contentHash)) continue;
      seen.add(orphan.contentHash);
      try {
        await rm(join(this.dataDir, storageRelPath(orphan.contentHash)), { force: true });
        removedBlobs += 1;
      } catch {
        errors += 1;
      }
    }
    return { removedParsed: orphans.length, removedBlobs, errors };
  }

  private async collectLocalMirror(contentHash: string): Promise<void> {
    const nonLocalCatalogReference = this.db.select({ id: fileVersions.id }).from(fileVersions)
      .innerJoin(fileEntries, eq(fileVersions.fileEntryId, fileEntries.id))
      .where(and(eq(fileVersions.contentHash, contentHash), ne(fileEntries.sourceKind, "local-folder")))
      .limit(1).get();
    const legacyReference = this.db.select({ id: uploadedFiles.id }).from(uploadedFiles)
      .where(eq(uploadedFiles.contentHash, contentHash)).limit(1).get();
    if (nonLocalCatalogReference || legacyReference) return;
    await rm(join(this.dataDir, storageRelPath(contentHash)), { force: true }).catch(() => undefined);
  }
}
