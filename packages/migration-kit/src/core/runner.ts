import type {
  DataMigration,
  MigrationLogger,
  MigrationRegistry,
  MigrationResult,
} from "./types.js";
import { MigrationFailureError } from "./types.js";
import { validateMigrations } from "./validate.js";

export interface RunMigrationsOptions<Ctx> {
  storeId: string;
  migrations: readonly DataMigration<Ctx>[];
  /** v1 = 基线：本框架首次接管时存量数据的格式版本。 */
  baselineVersion: number;
  /** 打开前存储不存在（全新安装）时为 true；此时只记录版本、不执行任何迁移。 */
  isFreshStore: boolean;
  registry: MigrationRegistry;
  /** 单个迁移的事务包装；recordApplied 必须在事务内被调用。 */
  withTransaction: (fn: () => void) => void;
  /** 仅当存在待执行迁移时调用；返回备份路径。 */
  backup?: (fromVersion: number, toVersion: number) => string | null;
  /** 迁移失败时用备份恢复存储。 */
  restore?: (backupPath: string) => void;
  makeContext: () => Ctx;
  logger?: MigrationLogger;
  onRollbackError?: (error: unknown) => void;
}

/**
 * 统一迁移执行入口（同步；SQLite 两驱动均为同步 API）。
 *
 * 认领语义：
 * - 全新存储：记录全部版本（via=fresh-claim），不执行任何 up。
 * - 存量存储且无版本记录：先记 baseline（via=baseline-claim），再执行
 *   大于基线的待办迁移。存量数据由各存储既有的探测式兼容层保证 schema
 *   已补齐到基线形态。
 * - 已有版本记录：只执行 version 更大的迁移。
 *
 * 失败语义：任一迁移抛错 → 尝试用备份整体恢复 → 抛 MigrationFailureError。
 */
export function runMigrations<Ctx>(options: RunMigrationsOptions<Ctx>): MigrationResult {
  const { storeId, migrations, baselineVersion, isFreshStore, registry } = options;
  validateMigrations(migrations, baselineVersion, storeId);

  const target = migrations.length > 0
    ? migrations[migrations.length - 1]!.version
    : baselineVersion;

  let current = registry.getCurrentVersion();
  let claimed: MigrationResult["claimed"] = null;

  if (current === null) {
    if (isFreshStore) {
      registry.recordApplied(baselineVersion, "baseline", "fresh-claim");
      for (const migration of migrations) {
        registry.recordApplied(migration.version, migration.name, "fresh-claim");
      }
      options.logger?.info(`[${storeId}] fresh store claimed at v${String(target)}`);
      return { fromVersion: null, toVersion: target, applied: [], claimed: "fresh", backupPath: null };
    }
    registry.recordApplied(baselineVersion, "baseline", "baseline-claim");
    claimed = "existing";
    current = baselineVersion;
    options.logger?.info(`[${storeId}] existing store claimed at baseline v${String(baselineVersion)}`);
  }

  const pending = migrations.filter((migration) => migration.version > current!);
  if (pending.length === 0) {
    return { fromVersion: current, toVersion: current, applied: [], claimed, backupPath: null };
  }

  let backupPath: string | null = null;
  let inFlight: DataMigration<Ctx> | null = null;
  try {
    backupPath = options.backup?.(current, target) ?? null;
    if (backupPath !== null) {
      options.logger?.info(
        `[${storeId}] migrating v${String(current)} -> v${String(target)}, backup: ${backupPath}`,
      );
    }
    const applied: MigrationResult["applied"] = [];
    for (const migration of pending) {
      inFlight = migration;
      const ctx = options.makeContext();
      options.withTransaction(() => {
        migration.up(ctx);
        registry.recordApplied(migration.version, migration.name, "migration");
      });
      applied.push({ version: migration.version, name: migration.name });
      options.logger?.info(`[${storeId}] applied ${migration.name} (v${String(migration.version)})`);
    }
    inFlight = null;
    return { fromVersion: current, toVersion: target, applied, claimed, backupPath };
  } catch (error) {
    if (backupPath !== null && options.restore !== undefined) {
      try {
        options.restore(backupPath);
      } catch (rollbackError) {
        options.onRollbackError?.(rollbackError);
      }
    }
    throw new MigrationFailureError(
      storeId,
      inFlight?.version ?? 0,
      inFlight?.name ?? "backup",
      backupPath,
      error,
    );
  }
}
