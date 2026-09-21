export interface DataMigration<Ctx = unknown> {
  /** 目标版本；迁移链按 version 严格递增，首项必须大于基线版本。 */
  version: number;
  /** 稳定 kebab-case 标识，用于日志与备份文件命名。 */
  name: string;
  /** 把数据从 version-1 格式变换到 version 格式。必须同步、可重放。 */
  up: (ctx: Ctx) => void;
}

export type MigrationVia = "migration" | "baseline-claim" | "fresh-claim";

export interface MigrationRegistry {
  /** 已应用的最高版本；null = 尚无记录（新库或未认领的存量库）。 */
  getCurrentVersion(): number | null;
  /** 记录已应用版本。调用方须保证与迁移本身同事务/同原子单元。 */
  recordApplied(version: number, name: string, via: MigrationVia): void;
}

export interface MigrationResult {
  fromVersion: number | null;
  toVersion: number;
  applied: Array<{ version: number; name: string }>;
  claimed: "existing" | "fresh" | null;
  backupPath: string | null;
}

export type MigrationLogger = Pick<Console, "info" | "warn" | "error">;

export class MigrationFailureError extends Error {
  readonly storeId: string;
  readonly failedVersion: number;
  readonly failedName: string;
  readonly backupPath: string | null;

  constructor(
    storeId: string,
    failedVersion: number,
    failedName: string,
    backupPath: string | null,
    cause: unknown,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `[data-migration-failed] store=${storeId} failed=${failedName}(v${String(failedVersion)})` +
        (backupPath === null ? "" : ` backup=${backupPath}`) +
        `: ${causeMessage}`,
    );
    this.name = "MigrationFailureError";
    this.storeId = storeId;
    this.failedVersion = failedVersion;
    this.failedName = failedName;
    this.backupPath = backupPath;
    this.cause = cause;
  }
}
