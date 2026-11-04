import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * 一次性清理同步时代的本地产物（迁移 0088 只删表，不删文件）：
 *   - database/connectors.sqlite（连接/scope/run/records 的独立库）
 *   - connectors/documents（同步下来的 markdown）
 *
 * 幂等：文件/目录不存在时 no-op；只删这两个已知路径。
 */
export function cleanupLegacyConnectorData(dataDir: string): string[] {
  const removed: string[] = [];
  const databasePath = join(dataDir, "database", "connectors.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${databasePath}${suffix}`;
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    removed.push(path);
  }
  const documentsDir = join(dataDir, "connectors", "documents");
  if (existsSync(documentsDir)) {
    rmSync(documentsDir, { recursive: true, force: true });
    removed.push(documentsDir);
  }
  return removed;
}
