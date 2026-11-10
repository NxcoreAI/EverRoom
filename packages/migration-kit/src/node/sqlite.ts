import { copyFileSync, rmSync } from "node:fs";
import type { DataMigration, MigrationLogger, MigrationRegistry, MigrationResult, MigrationVia } from "../core/types.js";
import { runMigrations } from "../core/runner.js";
import { pruneBackups, vacuumIntoBackup } from "./backup.js";

/** better-sqlite3 与 node:sqlite（DatabaseSync）共同满足的最小结构接口。 */
export interface MinimalSqliteStatement {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

export interface MinimalSqlite {
  exec(sql: string): unknown;
  prepare(sql: string): MinimalSqliteStatement;
}

export interface SqliteMigrationContext {
  sqlite: MinimalSqlite;
}

/** sql 为可选便捷项：声明式语句在事务内先于 up 执行。 */
export interface SqliteDataMigration extends Partial<DataMigration<SqliteMigrationContext>> {
  version: number;
  name: string;
  sql?: string | string[];
}

export interface RunSqliteMigrationsOptions {
  storeId: string;
  sqlite: MinimalSqlite;
  databasePath: string;
  /** null 或 databasePath 为 ":memory:" 时跳过备份。 */
  backupDir: string | null;
  isFreshStore: boolean;
  migrations: readonly SqliteDataMigration[];
  baselineVersion?: number;
  /** 启用了备份就必须提供（恢复前须关闭连接）。 */
  close?: () => void;
  logger?: MigrationLogger;
}

/**
 * 各库统一的版本寄存器表。由框架自管，不要加进 drizzle schema：
 * drizzle-kit 会为它生成无 IF NOT EXISTS 的 CREATE TABLE，在已认领库上会炸。
 */
export function createSqliteRegistry(sqlite: MinimalSqlite): MigrationRegistry {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS data_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    via TEXT NOT NULL DEFAULT 'migration-kit'
  )`);
  return {
    getCurrentVersion: () => {
      const row = sqlite.prepare("SELECT MAX(version) AS version FROM data_migrations")
        .get() as { version?: number | null } | undefined;
      const version = row?.version;
      return typeof version === "number" ? version : null;
    },
    recordApplied: (version: number, name: string, via: MigrationVia) => {
      sqlite
        .prepare(
          "INSERT INTO data_migrations (version, name, applied_at, via) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(version) DO NOTHING",
        )
        .run(version, name, new Date().toISOString(), via);
    },
  };
}

function sqliteTransaction(sqlite: MinimalSqlite, fn: () => void): void {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    fn();
    sqlite.exec("COMMIT");
  } catch (error) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // 连接已坏时 ROLLBACK 失败，交由上层整体恢复。
    }
    throw error;
  }
}

/** 删 db/-wal/-shm 三件套后把备份复制回原位。调用前须已 close。 */
export function restoreSqliteDatabase(databasePath: string, backupPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
  copyFileSync(backupPath, databasePath);
}

export function runSqliteMigrations(options: RunSqliteMigrationsOptions): MigrationResult {
  const baselineVersion = options.baselineVersion ?? 1;
  const backupEnabled = options.backupDir !== null && options.databasePath !== ":memory:";
  const migrations: DataMigration<SqliteMigrationContext>[] = options.migrations.map((migration) => ({
    version: migration.version,
    name: migration.name,
    up: (ctx: SqliteMigrationContext) => {
      const statements = typeof migration.sql === "string" ? [migration.sql] : migration.sql;
      if (statements !== undefined) {
        for (const statement of statements) ctx.sqlite.exec(statement);
      }
      migration.up?.(ctx);
    },
  }));

  const result = runMigrations({
    storeId: options.storeId,
    migrations,
    baselineVersion,
    isFreshStore: options.isFreshStore,
    registry: createSqliteRegistry(options.sqlite),
    withTransaction: (fn) => sqliteTransaction(options.sqlite, fn),
    ...(backupEnabled
      ? {
          backup: (fromVersion: number, toVersion: number) =>
            vacuumIntoBackup(options.sqlite, options.backupDir!, options.storeId, fromVersion, toVersion),
          restore: (backupPath: string) => {
            options.close?.();
            restoreSqliteDatabase(options.databasePath, backupPath);
          },
        }
      : {}),
    makeContext: () => ({ sqlite: options.sqlite }),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    onRollbackError: (error) => {
      options.logger?.error(
        `[${options.storeId}] failed to restore from backup; original backup kept on disk`,
        error,
      );
    },
  });

  if (backupEnabled && result.applied.length > 0) {
    pruneBackups(options.backupDir!, options.storeId);
  }
  return result;
}
