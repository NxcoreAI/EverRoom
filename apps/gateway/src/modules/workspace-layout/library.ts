import { randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readdir, rename, stat, unlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { posix } from "node:path";
import { eq } from "drizzle-orm";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { agentWorkspaces } from "../../infrastructure/database/schema.js";
import { storageRelPath } from "../files/storage.js";
import type { SpaceLayoutMap } from "./markers.js";
import type { WorkspaceLayoutService } from "./service.js";

/**
 * 资料库落盘：把"库里的资料"变成"空间目录里真实存在的文件"。
 *
 * 语义（方案 §1.2 决策 a + §16 v2 布局）：
 * - 资料库根＝空间根（v2），资料/产物是**当前态**的实体文件（真实文件名、真实目录），
 *   访达/Git/Agent 都能直接用；新文件直接平铺在根上；
 * - `.everoffice/objects/<hash>` 是按内容寻址的不可变副本（导入去重 + 版本快照）；
 * - DB 的 `file_entries.relative_path` 记相对空间根的路径，`state='missing'`
 *   表示文件被外部删掉了（见 §12.1）。
 *
 * 单写者：所有落盘动作都从这里走，FilesService 只拿"结果路径"回写 DB。
 */

/** 一个空间里与资料库相关的绝对路径。 */
export interface SpaceLibraryTarget {
  spaceId: string;
  root: string;
  library: string;
  objects: string;
  trash: string;
  layout: SpaceLayoutMap;
}

/**
 * `source_kind` → 默认落点目录（相对空间根）。
 *
 * v2 起一律平铺在根（""）：像 coding agent 的工程目录一样，
 * 用户一眼就能看到所有产物，bash/访达/Git 都不用下钻。
 * 已经在子目录里的老条目不受影响——改名/重导入沿用原目录（见 FilesService.libraryDirFor）。
 */
export function defaultLibraryDirFor(_sourceKind: string): string {
  return "";
}

/** 磁盘友好的文件名：去分隔符/控制字符、折叠空白、截断，保留扩展名。 */
export function safeLibraryFileName(name: string, extension?: string): string {
  const base = (name.split(/[\\/]/u).pop() ?? name).normalize("NFC");
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/^[.\s]+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  // 改名时调用方只给"新名字"（无扩展名）：补回原扩展名，别把 .md 丢掉。
  const hasExtension = /\.[a-z0-9]{1,8}$/iu.test(cleaned);
  const stem = cleaned || "file";
  const withExtension = extension && !hasExtension ? `${stem}.${extension}` : stem;
  if (withExtension.length <= 120) return withExtension;
  const dot = withExtension.lastIndexOf(".");
  const ext = dot > 0 ? withExtension.slice(dot) : "";
  return `${withExtension.slice(0, 120 - ext.length)}${ext}`;
}

export class SpaceLibraryWriter {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly dataDir: string,
    private readonly layout: WorkspaceLayoutService,
  ) {}

  /** 解析空间目录；空间没绑目录（老数据/默认无盘）时返回 null，调用方走旧行为。 */
  targetOf(workspaceId: string | null | undefined): SpaceLibraryTarget | null {
    const id = workspaceId?.trim();
    if (!id) return null;
    const row = this.db.select({ path: agentWorkspaces.path }).from(agentWorkspaces)
      .where(eq(agentWorkspaces.id, id)).get();
    if (!row?.path) return null;
    const read = this.layout.detect(row.path);
    if (read.status !== "ok") return null;
    const paths = this.layout.pathsOf(row.path, read.marker.layout);
    return {
      spaceId: id,
      root: paths.root,
      library: paths.library,
      objects: paths.objects,
      trash: paths.trash,
      layout: read.marker.layout,
    };
  }

  /** 相对路径 → 绝对路径（相对路径一律用 POSIX 分隔符存 DB）。 */
  absolute(target: SpaceLibraryTarget, relPath: string): string {
    return join(target.library, ...relPath.split("/").filter(Boolean));
  }

  /**
   * 把一份内容落到 `Library/<dir>/<name>`。
   *
   * 字节来源优先级：空间内 `objects/<hash>` → 遗留对象库 `<dataDir>/files/sha256/...`。
   * 两者都没有（本地夹引用条目）返回 null——那种条目本来就不该有副本。
   * 同内容同目录已存在时直接用（去重），同目录同名不同内容时加 ` (2)`。
   */
  async materialize(input: {
    workspaceId: string;
    dir: string;
    fileName: string;
    contentHash: string;
    extension?: string;
  }): Promise<{ relPath: string; absolutePath: string } | null> {
    const target = this.targetOf(input.workspaceId);
    if (!target) return null;
    const blob = await this.ensureObjectBlob(target, input.contentHash);
    if (!blob) return null;
    const dir = input.dir.replace(/^\/+|\/+$/gu, "");
    const absoluteDir = join(target.library, ...dir.split("/").filter(Boolean));
    await mkdir(absoluteDir, { recursive: true });
    const desired = safeLibraryFileName(input.fileName, input.extension);
    const absolutePath = await this.pickFreePath(absoluteDir, desired, input.contentHash, blob);
    const relPath = dir ? posix.join(dir, posix.basename(absolutePath)) : posix.basename(absolutePath);
    return { relPath, absolutePath };
  }

  /** 改名（只动磁盘；DB 由调用方回写）。返回新的相对路径。 */
  async renameWithinLibrary(workspaceId: string, relPath: string, nextName: string): Promise<string | null> {
    const target = this.targetOf(workspaceId);
    if (!target) return null;
    const from = this.absolute(target, relPath);
    if (!existsSync(from)) return null;
    const dir = posix.dirname(relPath);
    const extension = posix.extname(relPath).replace(/^\./u, "");
    const absoluteDir = join(target.library, ...(dir === "." ? [] : dir.split("/")));
    const next = safeLibraryFileName(nextName, extension);
    const nextPath = await this.pickFreePath(absoluteDir, next, null, null);
    if (nextPath === from) return relPath;
    await rename(from, nextPath);
    return dir === "." ? posix.basename(nextPath) : posix.join(dir, posix.basename(nextPath));
  }

  /** 删除 → 放进空间回收站（`.everoffice/trash/<YYYYMMDD>/<uuid>/<name>`），可恢复。 */
  async trashWithinLibrary(workspaceId: string, relPath: string): Promise<boolean> {
    const target = this.targetOf(workspaceId);
    if (!target) return false;
    const from = this.absolute(target, relPath);
    if (!existsSync(from)) return false;
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/gu, "");
    const bucket = join(target.trash, stamp, randomUUID());
    await mkdir(bucket, { recursive: true });
    await rename(from, join(bucket, posix.basename(relPath)));
    return true;
  }

  /** 当前态文件是否还在盘上（reconcile / 目录卡片用）。 */
  exists(workspaceId: string, relPath: string): boolean {
    const target = this.targetOf(workspaceId);
    if (!target) return false;
    return existsSync(this.absolute(target, relPath));
  }

  /**
   * 确保 `objects/<hash>` 存在：优先用空间内的，其次从遗留对象库补一份。
   * 返回 blob 绝对路径；两处都没有则 null。
   */
  async ensureObjectBlob(target: SpaceLibraryTarget, contentHash: string): Promise<string | null> {
    if (!/^[a-f0-9]{64}$/u.test(contentHash)) return null;
    const objectPath = join(target.objects, contentHash);
    if (existsSync(objectPath)) return objectPath;
    const legacy = join(this.dataDir, storageRelPath(contentHash));
    if (!existsSync(legacy)) return null;
    await mkdir(dirname(objectPath), { recursive: true });
    await copyFile(legacy, objectPath);
    return objectPath;
  }

  /**
   * 目标路径选择：
   * - 目标已存在且内容相同（hash 一致）→ 直接复用（幂等重导入）；
   * - 目标已存在但内容不同 → `name (2).ext`、`name (3).ext`…；
   * - 目标不存在 → 建硬链（同卷零拷贝），跨卷/不支持时回落复制。
   */
  private async pickFreePath(
    absoluteDir: string,
    desired: string,
    contentHash: string | null,
    blobPath: string | null,
  ): Promise<string> {
    const dot = desired.lastIndexOf(".");
    const stem = dot > 0 ? desired.slice(0, dot) : desired;
    const ext = dot > 0 ? desired.slice(dot) : "";
    for (let index = 0; index < 500; index += 1) {
      const candidate = join(absoluteDir, index === 0 ? desired : `${stem} (${index + 1})${ext}`);
      if (!existsSync(candidate)) {
        if (!contentHash || !blobPath) return candidate;
        await this.linkOrCopy(blobPath, candidate);
        return candidate;
      }
      if (contentHash && (await this.sameContent(candidate, blobPath))) return candidate;
      if (!contentHash) return candidate;
    }
    throw new Error("space_library_name_exhausted");
  }

  private async sameContent(candidate: string, blobPath: string | null): Promise<boolean> {
    if (!blobPath) return false;
    try {
      const [left, right] = await Promise.all([stat(candidate), stat(blobPath)]);
      return left.size === right.size;
    } catch {
      return false;
    }
  }

  private async linkOrCopy(blobPath: string, destination: string): Promise<void> {
    try {
      await link(blobPath, destination);
    } catch {
      await copyFile(blobPath, destination);
    }
  }

  /** 递归列出 Library 下的文件（相对路径，POSIX 分隔符），跳过 `.cache` 与点目录。 */
  async listLibraryFiles(workspaceId: string): Promise<string[]> {
    const target = this.targetOf(workspaceId);
    if (!target) return [];
    const found: string[] = [];
    const walk = async (absolute: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const relative = prefix ? posix.join(prefix, entry.name) : entry.name;
        if (entry.isDirectory()) await walk(join(absolute, entry.name), relative);
        else if (entry.isFile()) found.push(relative);
      }
    };
    await walk(target.library, "");
    return found.sort();
  }

  /** 从回收站彻底删除（GC 用）。 */
  async purgeTrash(workspaceId: string, olderThanMs: number): Promise<number> {
    const target = this.targetOf(workspaceId);
    if (!target || !existsSync(target.trash)) return 0;
    let removed = 0;
    const cutoff = Date.now() - olderThanMs;
    for (const bucket of await readdir(target.trash, { withFileTypes: true }).catch(() => [])) {
      if (!bucket.isDirectory()) continue;
      const absolute = join(target.trash, bucket.name);
      const stamp = (await stat(absolute).catch(() => null))?.mtimeMs ?? Date.now();
      if (stamp > cutoff) continue;
      await rm(absolute, { recursive: true, force: true }).catch(() => undefined);
      removed += 1;
    }
    return removed;
  }

  /** 兜底清理（未用到的临时工具：单文件删除）。 */
  async removeAbsolute(path: string): Promise<void> {
    await unlink(path).catch(() => undefined);
  }
}
