import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { posix } from "node:path";
import { and, eq, isNull } from "drizzle-orm";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { fileEntries } from "../../infrastructure/database/schema.js";
import type { FilesService } from "../files/service.js";
import type { SpaceLibraryWriter } from "./library.js";

/**
 * 资料库与磁盘对账（P1，方案 §8.4）。
 *
 * 三件事，全部幂等：
 * - 盘上没了（用户在访达删了/搬了）→ 条目标 `missing`，不删库（可恢复）；
 * - 盘上回来了 → `missing` 恢复成 ready/processing；
 * - 盘上多了（用户直接往目录里扔文件）→ 以 `manual-upload` + `provider=filesystem` 入库，
 *   保留其相对路径（落到目录树里同一个位置）。
 *
 * 单文件导入有大小上限：大文件留给显式导入流程，避免一次扫描把网关撑爆。
 */

export interface SpaceReconcileReport {
  spaceId: string;
  /** 盘上扫到的文件数。 */
  scanned: number;
  /** 新入库的文件（相对路径）。 */
  added: string[];
  /** 磁盘上找不到、被标成 missing 的（相对路径）。 */
  missing: string[];
  /** 之前 missing、这次回到盘上的（相对路径）。 */
  restored: string[];
  /** 处理失败的（相对路径 + 原因）。 */
  failed: Array<{ path: string; reason: string }>;
}

/** 对账单文件上限（超过的交给手动导入，避免扫描时把整库读进内存）。 */
export const RECONCILE_MAX_FILE_BYTES = 64 * 1024 * 1024;

export async function reconcileSpaceLibrary(input: {
  db: GatewayDatabase;
  writer: SpaceLibraryWriter;
  files: FilesService;
  spaceId: string;
}): Promise<SpaceReconcileReport> {
  const { db, writer, files, spaceId } = input;
  const target = writer.targetOf(spaceId);
  if (!target) throw new Error("space_library_unbound");

  const diskFiles = await writer.listLibraryFiles(spaceId);
  const diskSet = new Set(diskFiles);
  const rows = db.select({
    id: fileEntries.id,
    relativePath: fileEntries.relativePath,
    state: fileEntries.state,
  }).from(fileEntries).where(and(
    eq(fileEntries.workspaceId, spaceId),
    isNull(fileEntries.deletedAt),
  )).all();

  const byPath = new Map<string, { id: string; state: string }>();
  for (const row of rows) {
    if (row.relativePath) byPath.set(row.relativePath, { id: row.id, state: row.state });
  }

  const report: SpaceReconcileReport = {
    spaceId,
    scanned: diskFiles.length,
    added: [],
    missing: [],
    restored: [],
    failed: [],
  };
  const now = new Date();

  // 1) 盘上没了 → missing（不删行，UI 标灰可恢复）。
  for (const [relativePath, row] of byPath) {
    if (diskSet.has(relativePath)) continue;
    if (row.state === "missing") continue;
    db.update(fileEntries).set({ state: "missing", updatedAt: now })
      .where(eq(fileEntries.id, row.id)).run();
    report.missing.push(relativePath);
  }

  // 2) 回来了 → 清掉 missing。
  for (const [relativePath, row] of byPath) {
    if (!diskSet.has(relativePath) || row.state !== "missing") continue;
    db.update(fileEntries).set({ state: "processing", updatedAt: now })
      .where(eq(fileEntries.id, row.id)).run();
    report.restored.push(relativePath);
  }

  // 3) 盘上多了 → 入库（保留其在目录树中的位置）。
  for (const relativePath of diskFiles) {
    if (byPath.has(relativePath)) continue;
    const absolute = writer.absolute(target, relativePath);
    try {
      const info = await stat(absolute);
      if (!info.isFile() || info.size === 0) continue;
      if (info.size > RECONCILE_MAX_FILE_BYTES) {
        report.failed.push({ path: relativePath, reason: "file_too_large" });
        continue;
      }
      const buffer = await readFile(absolute);
      await files.importFile({
        sourceKind: "manual-upload",
        sourceKey: `filesystem:${spaceId}:${relativePath}`,
        originalName: posix.basename(relativePath),
        // 不写 provider：目录来源靠 sourceKey（filesystem:<space>:<rel>）表达，
        // 列表里显示成「手动上传」更准确。
        relativePath: posix.dirname(relativePath) === "." ? undefined : posix.dirname(relativePath),
        workspaceId: spaceId,
        buffer,
      });
      report.added.push(relativePath);
    } catch (error) {
      report.failed.push({
        path: relativePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}
