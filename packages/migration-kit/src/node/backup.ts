import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function formatBackupTimestamp(date: Date): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, "0");
  return (
    `${String(date.getUTCFullYear())}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** 按存储列举备份文件，文件名升序（时间戳嵌入文件名，天然按时间排序）。 */
export function listBackupFiles(backupDir: string, storeId: string, suffix = ".sqlite"): string[] {
  const prefix = `${storeId}-`;
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort()
    .map((name) => join(backupDir, name));
}

/** 每个存储只保留最近 keep 份备份。 */
export function pruneBackups(backupDir: string, storeId: string, keep = 5, suffix = ".sqlite"): void {
  const files = listBackupFiles(backupDir, storeId, suffix);
  const excess = files.length - keep;
  for (let index = 0; index < excess; index += 1) {
    try {
      rmSync(files[index]!, { force: true });
    } catch {
      // 删除失败不阻塞启动；下次迁移后再试。
    }
  }
}

interface VacuumCapableSqlite {
  exec(sql: string): unknown;
}

/**
 * VACUUM INTO 产出一致性快照（自动处理 WAL），目标文件不能已存在。
 * 同一秒内多次备份时追加序号避免冲突。
 */
export function vacuumIntoBackup(
  sqlite: VacuumCapableSqlite,
  backupDir: string,
  storeId: string,
  fromVersion: number,
  toVersion: number,
): string {
  mkdirSync(backupDir, { recursive: true });
  const stamp = formatBackupTimestamp(new Date());
  const base = `${storeId}-v${String(fromVersion)}-to-v${String(toVersion)}-${stamp}`;
  let path = join(backupDir, `${base}.sqlite`);
  for (let attempt = 2; ; attempt += 1) {
    try {
      sqlite.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
      return path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already exists")) throw error;
      path = join(backupDir, `${base}-${String(attempt)}.sqlite`);
    }
  }
}

/** JSON 文件迁移前的副本备份；保留原文件权限。 */
export function backupJsonFile(filePath: string, backupDir: string, label: string): string | null {
  try {
    mkdirSync(backupDir, { recursive: true });
    const path = join(backupDir, `${label}-${formatBackupTimestamp(new Date())}.json`);
    copyFileSync(filePath, path);
    return path;
  } catch {
    return null;
  }
}

/** 迁移失败后的恢复：先备份当前损坏文件再恢复原内容，均尽力而为。 */
export function quarantineJsonFile(filePath: string): void {
  try {
    copyFileSync(filePath, `${filePath}.broken-${formatBackupTimestamp(new Date())}`);
  } catch {
    // 归档失败不阻塞降级返回默认值。
  }
}

export function ensureFilePermissions(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // 文件系统不支持时忽略。
  }
}
