import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, ne } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { ingestEvents, parsedContents, uploadedFiles } from "../../infrastructure/database/schema.js";
import {
  contentHashOf,
  fileIdOf,
  MARKDOWN_PARSER_VERSION,
  storageRelPath,
  storeFileBlob,
} from "./storage.js";

export type UploadedFileRow = typeof uploadedFiles.$inferSelect;

/** 文件中心允许的原始文件格式；JSON 不是文件入口格式。 */
export const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  ".csv", ".docx", ".html", ".htm", ".md", ".markdown", ".pptx", ".txt", ".xlsx",
]);

export function isSupportedUploadFilename(filename: string): boolean {
  const basename = filename.split(/[\\/]/).pop() ?? filename;
  const dot = basename.lastIndexOf(".");
  return dot > 0 && SUPPORTED_UPLOAD_EXTENSIONS.has(basename.slice(dot).toLowerCase());
}

export function isJsonFilename(filename: string): boolean {
  const basename = filename.split(/[\\/]/).pop() ?? filename;
  return basename.toLowerCase().endsWith(".json");
}

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
  constructor(
    private readonly db: GatewayDatabase,
    private readonly dataDir: string,
  ) {}

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
  }): Promise<FileUploadResult> {
    if (!isSupportedUploadFilename(input.filename)) {
      throw new Error("不支持的文件格式：JSON 文件不会进入文件库。");
    }
    const fileId = fileIdOf(input.filename);
    const contentHash = contentHashOf(input.buffer);

    const existing = this.db.select().from(uploadedFiles).where(eq(uploadedFiles.id, fileId)).get();
    if (existing?.contentHash === contentHash) {
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
    const row = this.getRaw(fileId);
    return row && !isJsonFilename(row.originalName) ? row : null;
  }

  private getRaw(fileId: string): UploadedFileRow | null {
    return this.db.select().from(uploadedFiles).where(eq(uploadedFiles.id, fileId)).get() ?? null;
  }

  list(limit = 50, offset = 0): { items: UploadedFileRow[]; total: number } {
    const rows = this.db.select().from(uploadedFiles)
      .orderBy(desc(uploadedFiles.updatedAt))
      .all()
      .filter((row) => !isJsonFilename(row.originalName));
    return { items: rows.slice(offset, offset + limit), total: rows.length };
  }

  /** 启动时清除旧版本错误写入的 JSON 文件及其文件台账事件。 */
  async purgeUnsupportedFiles(): Promise<number> {
    const rows = this.db.select().from(uploadedFiles).all()
      .filter((row) => isJsonFilename(row.originalName));
    for (const row of rows) {
      this.db.delete(ingestEvents).where(and(
        eq(ingestEvents.sourceKind, "file"),
        eq(ingestEvents.sourceId, row.id),
      )).run();
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

  /** 改显示名（身份 ID 不变——确定性身份在首次上传时定死，aliases 语义）。 */
  rename(fileId: string, displayName: string): UploadedFileRow | null {
    const name = displayName.trim().slice(0, 300);
    if (!name || isJsonFilename(name)) return null;
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
    if (isJsonFilename(input.originalName)) return null;
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
    const file = this.getRaw(fileId);
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
      this.db.select({ contentHash: uploadedFiles.contentHash }).from(uploadedFiles).all()
        .map((row) => row.contentHash),
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
}
