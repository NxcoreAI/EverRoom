import type { DataMigration } from "./types.js";

const MIGRATION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 校验迁移链不变量：version 严格递增且不重复、首项大于基线版本、
 * name 为 kebab-case（会进入备份文件名与日志）。
 */
export function validateMigrations<Ctx>(
  migrations: readonly DataMigration<Ctx>[],
  baselineVersion: number,
  storeId: string,
): void {
  let previous = baselineVersion;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version)) {
      throw new Error(`[${storeId}] migration ${String(migration.name)}: version must be a safe integer`);
    }
    if (migration.version <= previous) {
      throw new Error(
        `[${storeId}] migration ${String(migration.name)}: version ${String(migration.version)} must be greater than ${String(previous)}`,
      );
    }
    if (typeof migration.name !== "string" || !MIGRATION_NAME_PATTERN.test(migration.name)) {
      throw new Error(
        `[${storeId}] migration v${String(migration.version)}: name must be kebab-case, got ${JSON.stringify(migration.name)}`,
      );
    }
    if (typeof migration.up !== "function") {
      throw new Error(`[${storeId}] migration ${migration.name}: up must be a function`);
    }
    previous = migration.version;
  }
}
