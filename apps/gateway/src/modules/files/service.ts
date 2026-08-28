import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  fileBlobs,
  clipperAssets,
  clipperCaptures,
  fileClassifications,
  fileClusterMemberships,
  fileClusters,
  fileEntries,
  fileVersions,
  ingestEvents,
  jobs,
  parsedContents,
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

export type FileSourceKind = "manual-upload" | "local-folder" | "connector" | "migration" | "web-clipper" | "legacy-upload";

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
  parsed: boolean;
  updatedAt: string;
}

interface VersionIngestResult {
  eventId: string;
  parsedId: string;
  dataType: string;
}

type VersionIngestor = (input: {
  fileEntryId: string;
  fileVersionId: string;
  pipelines?: FileImportInput["pipelines"];
  roomId?: string;
}) => Promise<VersionIngestResult>;
type VersionClassifier = (fileEntryId: string, fileVersionId: string) => void;

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

/** 删除级联钩子（create-server 注入；files 模块不反向依赖 knowledge/memory）。 */
export interface FileDeletionHooks {
  /** Room/wiki 链路清理（enqueueCleanup 同款异步 job）。 */
  requestKnowledgeCleanup?(fileId: string): void;
  /** 记忆链路：按 caller_ref 删 MemoryCore 文档；返回删除的 documentId 列表。 */
  deleteMemoryDocuments?(fileId: string): Promise<string[]>;
}

export interface FileDeletionResult {
  fileId: string;
  /** Room/wiki 侧是否已入队清理 job。 */
  knowledgeCleanup: boolean;
  /** 记忆侧实际删除的 documentId（MemoryCore 未启用/无文档为空）。 */
  deletedMemoryDocuments: string[];
  /** 对象库 blob 是否被物理回收（被其他文件共享的内容不回收）。 */
  blobCollected: boolean;
}

/**
 * 文件管理中心（unified-ingest-plan §8/U9）：对象库 + uploaded_files +
 * parsed_contents 的唯一所有者。knowledge/memory/ingest 的一切字节存取
 * 都经它——上传（闸1 判重）、解析产物（闸2 幂等）、预览、改名、删除级联
 * 与对象库 GC。表与磁盘结构沿用 knowledge 时期的设计，零迁移。
 */
export class FilesService {
  private versionIngestor: VersionIngestor | null = null;
  private versionClassifier: VersionClassifier | null = null;
  private fileJobWorker: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly dataDir: string,
  ) {}

  /** Backfill the compatibility table without changing any legacy IDs. */
  initializeCatalog(): void {
    const legacyRows = this.db.select().from(uploadedFiles).all();
    for (const row of legacyRows) {
      const capability = fileFormatCapability(row.originalName);
      if (!capability) continue;
      const versionId = `fver-legacy-${row.id}`;
      this.db.insert(fileBlobs).values({
        contentHash: row.contentHash,
        storagePath: row.storagePath,
        byteSize: row.bytes,
        mime: row.mime,
        createdAt: row.createdAt,
      }).onConflictDoNothing().run();
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

  setVersionClassifier(classifier: VersionClassifier): void {
    this.versionClassifier = classifier;
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
    let entry = this.db.select().from(fileEntries).where(and(
      eq(fileEntries.sourceKind, input.sourceKind),
      eq(fileEntries.sourceKey, input.sourceKey),
    )).get();
    const fileEntryId = entry?.id ?? `file-${randomUUID()}`;
    const existingVersion = entry
      ? this.db.select().from(fileVersions).where(and(
          eq(fileVersions.fileEntryId, entry.id),
          eq(fileVersions.contentHash, contentHash),
        )).get()
      : null;

    if (existingVersion) {
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
      this.db.update(fileEntries).set({
        originalName: input.originalName,
        relativePath: input.relativePath,
        sourcePath: input.sourcePath,
        sourceUri: input.sourceUri,
        lastSeenAt: now,
        updatedAt: now,
        deletedAt: null,
        state: existingVersion.status === "parsed" ? "ready" : existingVersion.status === "failed" ? "failed" : "processing",
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

  touchVersionParsed(fileEntryId: string, fileVersionId: string, parsedId: string, ingestEventId: string): void {
    const now = new Date();
    this.db.update(fileVersions).set({
      parsedId, ingestEventId, status: "parsed", errorCode: null, errorMessage: null,
      processedAt: now,
    }).where(and(eq(fileVersions.id, fileVersionId), eq(fileVersions.fileEntryId, fileEntryId))).run();
    const entry = this.db.select().from(fileEntries).where(eq(fileEntries.id, fileEntryId)).get();
    if (entry?.currentVersionId === fileVersionId) {
      this.db.update(fileEntries).set({ state: "ready", updatedAt: now })
        .where(eq(fileEntries.id, fileEntryId)).run();
    }
    this.versionClassifier?.(fileEntryId, fileVersionId);
  }

  listCatalog(limit = 100, offset = 0): { items: CatalogFileDto[]; total: number } {
    const rows = this.db.select({
      entry: fileEntries,
      version: fileVersions,
      blob: fileBlobs,
      membership: fileClusterMemberships,
      cluster: fileClusters,
      classification: fileClassifications,
    }).from(fileEntries)
      .leftJoin(fileVersions, eq(fileEntries.currentVersionId, fileVersions.id))
      .leftJoin(fileBlobs, eq(fileVersions.contentHash, fileBlobs.contentHash))
      .leftJoin(fileClusterMemberships, eq(fileEntries.id, fileClusterMemberships.fileEntryId))
      .leftJoin(fileClusters, eq(fileClusterMemberships.clusterId, fileClusters.id))
      .leftJoin(fileClassifications, eq(fileVersions.id, fileClassifications.fileVersionId))
      .where(isNull(fileEntries.deletedAt))
      .orderBy(desc(fileEntries.updatedAt)).limit(limit).offset(offset).all();
    const items = rows.map(({ entry, version, blob, cluster, classification }) => ({
      id: entry.id,
      originalName: entry.originalName,
      displayName: entry.displayName,
      sharedTitle: cluster?.canonicalTitle ?? entry.displayName ?? entry.originalName,
      sourceKind: entry.sourceKind,
      sourceLabel: entry.provider ?? (entry.sourceKind === "local-folder" ? "本地文件夹" : entry.sourceKind === "manual-upload" ? "手动上传" : entry.sourceKind === "web-clipper" ? "网页剪藏" : "历史上传"),
      relativePath: entry.relativePath,
      provider: entry.provider,
      bytes: blob?.byteSize ?? 0,
      dataType: fileFormatCapability(entry.originalName)?.dataType ?? null,
      agentCategory: classification?.category ?? null,
      summary: classification?.summary ?? null,
      tags: classification?.tags ?? [],
      processingState: entry.state === "deleted" ? "missing" : entry.state,
      clusterId: cluster?.id ?? null,
      contentHash: version?.contentHash ?? "",
      parsed: Boolean(version?.parsedId),
      updatedAt: entry.updatedAt.toISOString(),
    } satisfies CatalogFileDto));
    const total = this.db.select({ id: fileEntries.id }).from(fileEntries)
      .where(isNull(fileEntries.deletedAt)).all().length;
    return { items, total };
  }

  capabilities() {
    return FILE_FORMAT_CAPABILITIES;
  }

  isCatalogEntry(fileEntryId: string): boolean {
    const entry = this.db.select({ sourceKind: fileEntries.sourceKind }).from(fileEntries)
      .where(eq(fileEntries.id, fileEntryId)).get();
    return Boolean(entry && entry.sourceKind !== "legacy-upload");
  }

  catalogMarkdownOf(fileEntryId: string): string | null {
    const row = this.db.select({ markdown: parsedContents.markdown }).from(fileEntries)
      .innerJoin(fileVersions, eq(fileEntries.currentVersionId, fileVersions.id))
      .innerJoin(parsedContents, eq(fileVersions.parsedId, parsedContents.id))
      .where(eq(fileEntries.id, fileEntryId)).get();
    return row?.markdown ?? null;
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
    return { buffer: await readFile(path), mime: row.blob.mime, filename: row.entry.originalName };
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

  renameCatalogEntry(fileEntryId: string, displayName: string): CatalogFileDto | null {
    const normalized = displayName.trim().slice(0, 300);
    if (!normalized) throw new Error("显示名不能为空");
    this.db.update(fileEntries).set({ displayName: normalized, updatedAt: new Date() })
      .where(eq(fileEntries.id, fileEntryId)).run();
    return this.listCatalog(200, 0).items.find((item) => item.id === fileEntryId) ?? null;
  }

  async deleteCatalogEntry(fileEntryId: string, hooks?: FileDeletionHooks): Promise<FileDeletionResult | null> {
    const entry = this.db.select().from(fileEntries).where(eq(fileEntries.id, fileEntryId)).get();
    if (!entry || entry.sourceKind === "legacy-upload") return null;
    const versions = this.db.select().from(fileVersions).where(eq(fileVersions.fileEntryId, fileEntryId)).all();
    const clipperAssetHashes = this.db.select({ contentHash: clipperAssets.contentHash }).from(clipperAssets)
      .innerJoin(clipperCaptures, eq(clipperAssets.captureId, clipperCaptures.id))
      .where(eq(clipperCaptures.fileEntryId, fileEntryId)).all()
      .flatMap(({ contentHash }) => contentHash ? [contentHash] : []);
    const membership = this.db.select().from(fileClusterMemberships)
      .where(eq(fileClusterMemberships.fileEntryId, fileEntryId)).get();
    // Keep the local clipping available for retry if its external memory cleanup fails.
    let deletedMemoryDocuments = entry.sourceKind === "web-clipper" && hooks?.deleteMemoryDocuments
      ? await hooks.deleteMemoryDocuments(fileEntryId)
      : [];
    this.db.delete(fileEntries).where(eq(fileEntries.id, fileEntryId)).run();
    if (membership) {
      const remaining = this.db.select({ id: fileClusterMemberships.fileEntryId }).from(fileClusterMemberships)
        .where(eq(fileClusterMemberships.clusterId, membership.clusterId)).limit(1).get();
      if (!remaining) this.db.delete(fileClusters).where(eq(fileClusters.id, membership.clusterId)).run();
    }
    let knowledgeCleanup = false;
    if (hooks?.requestKnowledgeCleanup) {
      hooks.requestKnowledgeCleanup(fileEntryId);
      knowledgeCleanup = true;
    }
    if (entry.sourceKind !== "web-clipper" && hooks?.deleteMemoryDocuments) {
      deletedMemoryDocuments = await hooks.deleteMemoryDocuments(fileEntryId);
    }
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
    for (const contentHash of new Set(clipperAssetHashes)) {
      const catalogReference = this.db.select({ id: fileVersions.id }).from(fileVersions)
        .where(eq(fileVersions.contentHash, contentHash)).limit(1).get();
      const legacyReference = this.db.select({ id: uploadedFiles.id }).from(uploadedFiles)
        .where(eq(uploadedFiles.contentHash, contentHash)).limit(1).get();
      const clipperReference = this.db.select({ id: clipperAssets.id }).from(clipperAssets)
        .where(eq(clipperAssets.contentHash, contentHash)).limit(1).get();
      if (!catalogReference && !legacyReference && !clipperReference) {
        const blob = this.db.select().from(fileBlobs).where(eq(fileBlobs.contentHash, contentHash)).get();
        this.db.delete(fileBlobs).where(eq(fileBlobs.contentHash, contentHash)).run();
        if (blob) await rm(join(this.dataDir, blob.storagePath), { force: true }).catch(() => undefined);
        blobCollected = true;
      }
    }
    if (entry.sourceKind === "local-folder") {
      for (const version of versions) {
        await this.collectLocalMirror(version.contentHash);
      }
    }
    return { fileId: fileEntryId, knowledgeCleanup, deletedMemoryDocuments, blobCollected };
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
          this.touchVersionParsed(payload.fileEntryId, payload.fileVersionId, result.parsedId, result.eventId);
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
      this.db.delete(ingestEvents).where(and(eq(ingestEvents.sourceKind, "file"), eq(ingestEvents.sourceId, row.id))).run();
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
   * 引擎归一化后调用；knowledge/memory 的既有导入路径同样经此落解析。
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
   * 删除 + 级联清理（§8.2）：knowledge 走 enqueueCleanup（wiki raw/rm +
   * 决策回退），memory 按 caller_ref 删文档，登记行随删；parsed_contents
   * 与对象库 blob 仅当无其他 uploaded_files 行引用同一 hash 时物理回收
   * （内容寻址天然共享）。
   */
  async deleteFile(fileId: string, hooks?: FileDeletionHooks): Promise<FileDeletionResult | null> {
    const file = this.get(fileId);
    if (!file) return null;

    hooks?.requestKnowledgeCleanup?.(fileId);
    let deletedMemoryDocuments: string[] = [];
    if (hooks?.deleteMemoryDocuments) {
      try {
        deletedMemoryDocuments = await hooks.deleteMemoryDocuments(fileId);
      } catch {
        // 记忆侧清理是 best-effort：登记行照删，失败留给手动 GC/重试
        deletedMemoryDocuments = [];
      }
    }

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

    return {
      fileId,
      knowledgeCleanup: Boolean(hooks?.requestKnowledgeCleanup),
      deletedMemoryDocuments,
      blobCollected,
    };
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
