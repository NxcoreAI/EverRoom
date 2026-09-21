import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MigrationLogger } from "../core/types.js";
import { backupJsonFile, ensureFilePermissions, quarantineJsonFile } from "./backup.js";

export interface JsonDataMigration<T> {
  /** 目标版本；从 v2 起严格递增。 */
  version: number;
  name: string;
  up: (data: T) => T;
}

export interface VersionedJsonStoreOptions<T> {
  filePath: string;
  migrations: readonly JsonDataMigration<T>[];
  /** 裸 JSON（无 envelope，即旧格式文件）→ v1 数据；抛错视为文件损坏。 */
  adoptBaseline: (raw: unknown) => T;
  /** 文件缺失或（非 failHard 模式下）损坏时的默认值。 */
  fallback: T;
  /** true：读取失败抛错（调用方负责停机提示）；false：归档损坏文件并返回默认值。 */
  failHard?: boolean;
  /** 提供时，发生版本迁移前会把旧文件复制一份到这里。 */
  backupDir?: string | null;
  logger?: MigrationLogger;
}

export class VersionedJsonReadError extends Error {
  constructor(
    readonly filePath: string,
    readonly cause: unknown,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`[versioned-json-failed] file=${filePath}: ${causeMessage}`);
    this.name = "VersionedJsonReadError";
  }
}

interface Envelope {
  v: number;
  data: unknown;
}

function isEnvelope(value: unknown, latestVersion: number): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["v"] === "number"
    && Number.isInteger(record["v"])
    && record["v"] >= 1
    && record["v"] <= latestVersion
    && "data" in record;
}

/**
 * 带版本的 JSON 状态文件：磁盘形态为 { "v": N, "data": ... }。
 * 读取时自动把旧版本迁移到最新并原子写回（tmp + rename，保留原权限）。
 */
export class VersionedJsonStore<T> {
  private readonly migrations: readonly JsonDataMigration<T>[];

  constructor(private readonly options: VersionedJsonStoreOptions<T>) {
    this.migrations = [...options.migrations].sort((a, b) => a.version - b.version);
  }

  private get latestVersion(): number {
    return this.migrations.length > 0
      ? this.migrations[this.migrations.length - 1]!.version
      : 1;
  }

  read(): T {
    let rawText: string;
    try {
      rawText = readFileSync(this.options.filePath, "utf8");
    } catch {
      return this.options.fallback;
    }

    let value: T;
    let fromVersion = 0;
    let changed = false;
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (isEnvelope(parsed, this.latestVersion)) {
        value = parsed.data as T;
        fromVersion = parsed.v;
      } else {
        value = this.options.adoptBaseline(parsed);
        fromVersion = 1;
      }
      changed = fromVersion !== this.latestVersion;
      for (const migration of this.migrations) {
        if (migration.version > fromVersion) {
          value = migration.up(value);
          changed = true;
        }
      }
    } catch (error) {
      if (this.options.failHard === true) {
        throw new VersionedJsonReadError(this.options.filePath, error);
      }
      quarantineJsonFile(this.options.filePath);
      this.options.logger?.error(
        `[versioned-json] ${this.options.filePath} unreadable; archived and using fallback`,
        error,
      );
      return this.options.fallback;
    }

    if (changed) {
      const migrated = value;
      if (this.options.backupDir != null) {
        backupJsonFile(this.options.filePath, this.options.backupDir, this.backupLabel(fromVersion));
      }
      try {
        this.write(migrated);
      } catch (error) {
        if (this.options.failHard === true) throw error;
        this.options.logger?.warn(
          `[versioned-json] ${this.options.filePath} migrated in memory but write-back failed; will retry next time`,
          error,
        );
      }
    }
    return value;
  }

  write(data: T): void {
    mkdirSync(dirname(this.options.filePath), { recursive: true });
    const payload = JSON.stringify({ v: this.latestVersion, data });
    const mode = this.existingMode() ?? 0o600;
    const tempPath = join(dirname(this.options.filePath), `.${basenameOf(this.options.filePath)}.tmp`);
    writeFileSync(tempPath, payload, { mode });
    ensureFilePermissions(tempPath, mode);
    renameSync(tempPath, this.options.filePath);
  }

  private existingMode(): number | null {
    try {
      return statSync(this.options.filePath).mode & 0o777;
    } catch {
      return null;
    }
  }

  private backupLabel(fromVersion: number): string {
    const name = basenameOf(this.options.filePath).replaceAll(".json", "");
    return `${name}-v${String(fromVersion)}-to-v${String(this.latestVersion)}`;
  }
}

function basenameOf(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] ?? path;
}
