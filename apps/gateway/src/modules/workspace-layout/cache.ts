import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { agentWorkspaces } from "../../infrastructure/database/schema.js";
import { defaultCacheGcPolicy, type SpaceCacheGcPolicy } from "./markers.js";
import type { WorkspaceLayoutService } from "./service.js";

/**
 * 空间内缓存（P3 + §16 v2 布局）：把 Agent/子系统的过程文件从系统临时目录搬进空间。
 *
 * 目录语义：
 * - `<空间根>/.tmp/<purpose>/<uuid>/`：scratch，小时级，退出即删（独立于元数据目录，
 *   用户可以从访达里整目录清掉）；
 * - `.everoffice/cache/derived/`：可重建的派生数据（解析 md、缩略图、切片），天级 LRU；
 * - `.everoffice/objects/`：内容寻址（导入去重 + 版本快照），由 library.ts 维护，
 *   这里只统计与按引用 GC。
 *
 * 空间没绑目录时 `withScratch` 回落系统临时目录——调用方不需要区分两种情况。
 */

export interface SpaceCacheStats {
  spaceId: string;
  bound: boolean;
  tmpBytes: number;
  derivedBytes: number;
  objectsBytes: number;
  totalBytes: number;
  tmpFiles: number;
  derivedFiles: number;
  objectFiles: number;
}

export interface SpaceScratchFile {
  /** 相对 `<space>/.tmp/` 的路径（POSIX 分隔符）。 */
  path: string;
  size: number;
  modifiedAt: string;
}

export interface SpaceScratchListing {
  spaceId: string;
  bound: boolean;
  /** `.tmp` 根本身是否存在（从没产生过临时文件时为 false）。 */
  present: boolean;
  entries: SpaceScratchFile[];
  /** 扫描到的文件数；`truncated=true` 时是下界（扫描在超上限处停止）。 */
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
}

/** 清单条数上限：只读排查用途，不做全量导出。 */
export const SCRATCH_LIST_MAX_ENTRIES = 500;

export interface SpaceCacheGcResult {
  spaceId: string;
  removedTmp: number;
  removedDerived: number;
  removedObjects: number;
  purgedTrash: number;
  freedBytes: number;
}

async function measure(directory: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (absolute: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        const info = await stat(child).catch(() => null);
        if (info) {
          bytes += info.size;
          files += 1;
        }
      }
    }
  };
  await walk(directory);
  return { bytes, files };
}

export class SpaceCacheManager {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly layout: WorkspaceLayoutService,
  ) {}

  /** 空间的缓存根；未绑目录返回 null。 */
  rootOf(workspaceId: string | null | undefined): {
    spaceId: string;
    tmp: string;
    derived: string;
    objects: string;
    trash: string;
    policy: SpaceCacheGcPolicy;
  } | null {
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
      tmp: paths.tmp,
      derived: paths.derived,
      objects: paths.objects,
      trash: paths.trash,
      policy: read.marker.roles.cache.gc ?? defaultCacheGcPolicy(),
    };
  }

  /**
   * 空间内的 scratch 目录（调用方负责清理，通常用 `withScratch`）。
   * 未绑目录时回落到系统临时目录，保证调用方不需要分支。
   */
  async createScratch(workspaceId: string | null | undefined, purpose: string): Promise<string> {
    const root = this.rootOf(workspaceId);
    const label = purpose.replace(/[^a-z0-9-]+/giu, "-").toLowerCase() || "task";
    if (!root) return mkdtemp(join(tmpdir(), `everroom-${label}-`));
    const directory = join(root.tmp, label, randomUUID());
    await mkdir(directory, { recursive: true });
    return directory;
  }

  /** 同步版本：给"已经在用同步 mkdtemp"的老调用点用（如 LibreOffice 转换）。 */
  scratchPathSync(workspaceId: string | null | undefined, purpose: string): string | null {
    const root = this.rootOf(workspaceId);
    if (!root) return null;
    const label = purpose.replace(/[^a-z0-9-]+/giu, "-").toLowerCase() || "task";
    const directory = join(root.tmp, label, randomUUID());
    try {
      mkdirSync(directory, { recursive: true });
      return directory;
    } catch {
      return null;
    }
  }

  /**
   * 在空间 scratch 里跑一段活，结束（无论成败）就删目录。
   * 未绑目录 → 系统临时目录，行为与老代码完全一致。
   */
  async withScratch<T>(
    workspaceId: string | null | undefined,
    purpose: string,
    fn: (directory: string) => Promise<T>,
  ): Promise<T> {
    const directory = await this.createScratch(workspaceId, purpose);
    try {
      return await fn(directory);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        .catch(() => undefined);
    }
  }

  async stats(workspaceId: string): Promise<SpaceCacheStats> {
    const root = this.rootOf(workspaceId);
    if (!root) {
      return {
        spaceId: workspaceId,
        bound: false,
        tmpBytes: 0,
        derivedBytes: 0,
        objectsBytes: 0,
        totalBytes: 0,
        tmpFiles: 0,
        derivedFiles: 0,
        objectFiles: 0,
      };
    }
    const [tmp, derived, objects] = await Promise.all([
      measure(root.tmp),
      measure(root.derived),
      measure(root.objects),
    ]);
    return {
      spaceId: workspaceId,
      bound: true,
      tmpBytes: tmp.bytes,
      derivedBytes: derived.bytes,
      objectsBytes: objects.bytes,
      totalBytes: tmp.bytes + derived.bytes + objects.bytes,
      tmpFiles: tmp.files,
      derivedFiles: derived.files,
      objectFiles: objects.files,
    };
  }

  /**
   * `.tmp/` 的只读清单（「临时文件」入口用）。
   *
   * 与资料库彻底分开：**只读目录、不写库、不进索引**——tmp 里是 Agent 的过程产物
   * （转换中间件、截图、转写文本），随时可能被 GC 掉，进索引只会制造 missing 噪音。
   * 按 mtime 倒序返回，条数上限 `SCRATCH_LIST_MAX_ENTRIES`；超限即停止扫描并标
   * `truncated`，此时 `fileCount`/`totalBytes` 是下界（界面上显示成 `500+`）。
   */
  async listScratch(workspaceId: string): Promise<SpaceScratchListing> {
    const listing: SpaceScratchListing = {
      spaceId: workspaceId,
      bound: false,
      present: false,
      entries: [],
      fileCount: 0,
      totalBytes: 0,
      truncated: false,
    };
    const root = this.rootOf(workspaceId);
    if (!root) return listing;
    listing.bound = true;
    if (!existsSync(root.tmp)) return listing;
    listing.present = true;

    const found: SpaceScratchFile[] = [];
    let totalBytes = 0;
    // 返回 false 表示已经取够，停止继续遍历（避免大目录把整棵树读进来）。
    const walk = async (absolute: string, prefix: string): Promise<boolean> => {
      let entries;
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch {
        return true;
      }
      for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const child = join(absolute, entry.name);
        if (entry.isDirectory()) {
          if (!(await walk(child, relative))) return false;
          continue;
        }
        if (!entry.isFile()) continue; // 符号链接等一律不跟
        const info = await stat(child).catch(() => null);
        if (!info) continue;
        listing.fileCount += 1;
        totalBytes += info.size;
        if (found.length < SCRATCH_LIST_MAX_ENTRIES) {
          found.push({ path: relative, size: info.size, modifiedAt: info.mtime.toISOString() });
        }
        if (found.length >= SCRATCH_LIST_MAX_ENTRIES && listing.fileCount > SCRATCH_LIST_MAX_ENTRIES) {
          // 已经确认超限：停止遍历，标记截断。
          listing.truncated = true;
          return false;
        }
      }
      return true;
    };
    await walk(root.tmp, "");
    listing.totalBytes = totalBytes;
    found.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    listing.entries = found;
    return listing;
  }

  /**
   * 缓存回收：
   * - `tmp/`：进程启动全清 + 超过 `tmpMaxAgeHours` 的清；
   * - `derived/`：超过 `derivedMaxAgeDays` 的 LRU 清理；
   * - `objects/`：超过 `objectsMaxAgeDays` 且**没有版本引用**的删（引用判断交给调用方）；
   * - `.everoffice/trash/`：30 天前的回收站彻底删除。
   */
  async gc(
    workspaceId: string,
    options: { referencedHashes?: ReadonlySet<string>; keepTmp?: boolean } = {},
  ): Promise<SpaceCacheGcResult> {
    const result: SpaceCacheGcResult = {
      spaceId: workspaceId,
      removedTmp: 0,
      removedDerived: 0,
      removedObjects: 0,
      purgedTrash: 0,
      freedBytes: 0,
    };
    const root = this.rootOf(workspaceId);
    if (!root) return result;
    const policy = root.policy;
    const now = Date.now();

    /**
     * 递归按龄清理：文件逐个判断（`tmp/<purpose>/<uuid>/a.bin` 也要能被清掉），
     * 清空的目录顺手剪掉。`objects/` 是平铺的，且被版本引用的永不删。
     */
    const sweep = async (
      directory: string,
      maxAgeMs: number,
      kind: "tmp" | "derived" | "objects",
      depth = 0,
    ): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          await sweep(absolute, maxAgeMs, kind, depth + 1);
          continue;
        }
        const info = await stat(absolute).catch(() => null);
        if (!info) continue;
        // 被版本引用的对象永不删（历史快照），其余按年龄清。
        if (kind === "objects" && options.referencedHashes?.has(entry.name)) continue;
        if (now - info.mtimeMs <= maxAgeMs) continue;
        await rm(absolute, { force: true }).catch(() => undefined);
        result.freedBytes += info.size;
        if (kind === "tmp") result.removedTmp += 1;
        else if (kind === "derived") result.removedDerived += 1;
        else result.removedObjects += 1;
      }
      // 空的子目录（purpose 目录下的 uuid 目录）一并剪掉；缓存根自己保留。
      if (depth > 0) {
        const remaining = await readdir(directory).catch(() => []);
        if (remaining.length === 0) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    };

    if (!options.keepTmp) {
      await sweep(root.tmp, policy.tmpMaxAgeHours * 60 * 60 * 1000, "tmp");
    }
    await sweep(root.derived, policy.derivedMaxAgeDays * 24 * 60 * 60 * 1000, "derived");
    await sweep(root.objects, policy.objectsMaxAgeDays * 24 * 60 * 60 * 1000, "objects");

    // 回收站：30 天前彻底删除。
    if (existsSync(root.trash)) {
      for (const bucket of await readdir(root.trash, { withFileTypes: true }).catch(() => [])) {
        if (!bucket.isDirectory()) continue;
        const absolute = join(root.trash, bucket.name);
        const info = await stat(absolute).catch(() => null);
        if (!info || now - info.mtimeMs < 30 * 24 * 60 * 60 * 1000) continue;
        result.freedBytes += (await measure(absolute)).bytes;
        await rm(absolute, { recursive: true, force: true }).catch(() => undefined);
        result.purgedTrash += 1;
      }
    }
    return result;
  }

  /** 所有已绑定目录的空间 id（启动清理用）。 */
  boundSpaceIds(): string[] {
    return this.db.select({ id: agentWorkspaces.id, path: agentWorkspaces.path }).from(agentWorkspaces).all()
      .filter((row) => Boolean(row.path))
      .map((row) => row.id);
  }
}
