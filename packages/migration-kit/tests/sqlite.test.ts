import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { MigrationFailureError } from "../src/core/types.js";
import { listBackupFiles, pruneBackups, vacuumIntoBackup } from "../src/node/backup.js";
import {
  createSqliteRegistry,
  runSqliteMigrations,
  type SqliteDataMigration,
} from "../src/node/sqlite.js";

let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "migration-kit-sqlite-"));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function openDatabase(path: string): Database.Database {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

describe("runSqliteMigrations", () => {
  it(":memory: 全新库：认领到最新且不备份", () => {
    const sqlite = openDatabase(":memory:");
    sqlite.exec("CREATE TABLE demo (id INTEGER PRIMARY KEY, value TEXT)");
    const result = runSqliteMigrations({
      storeId: "memory-test",
      sqlite,
      databasePath: ":memory:",
      backupDir: null,
      isFreshStore: true,
      migrations: [{ version: 2, name: "demo-v2", sql: "ALTER TABLE demo ADD COLUMN extra TEXT" }],
    });
    expect(result.claimed).toBe("fresh");
    expect(result.backupPath).toBeNull();
    expect(createSqliteRegistry(sqlite).getCurrentVersion()).toBe(2);
    sqlite.close();
  });

  it("存量库：声明式 SQL 迁移按序执行、写版本表、生成备份、幂等", () => {
    const databasePath = join(workspace, "existing.db");
    const backupDir = join(workspace, "backups");
    const sqlite = openDatabase(databasePath);
    sqlite.exec("CREATE TABLE demo (id INTEGER PRIMARY KEY, value TEXT)");
    sqlite.prepare("INSERT INTO demo (value) VALUES ('a'), ('b')").run();
    sqlite.close();

    const migrations: SqliteDataMigration[] = [
      { version: 2, name: "add-extra-column", sql: "ALTER TABLE demo ADD COLUMN extra TEXT" },
      {
        version: 3,
        name: "backfill-extra",
        up: (ctx) => {
          ctx.sqlite.prepare("UPDATE demo SET extra = value || '!'").run();
        },
      },
    ];

    const reopened = openDatabase(databasePath);
    const result = runSqliteMigrations({
      storeId: "existing.db",
      sqlite: reopened,
      databasePath,
      backupDir,
      isFreshStore: false,
      migrations,
      close: () => reopened.close(),
    });
    expect(result.applied.map((item) => item.version)).toEqual([2, 3]);
    expect(result.backupPath).not.toBeNull();
    expect(reopened.prepare("SELECT value, extra FROM demo ORDER BY id").all())
      .toEqual([{ value: "a", extra: "a!" }, { value: "b", extra: "b!" }]);
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM data_migrations WHERE via = 'migration'").get())
      .toEqual({ count: 2 });
    reopened.close();

    // 二次运行幂等：无待办、不新增备份。
    const again = openDatabase(databasePath);
    const secondRun = runSqliteMigrations({
      storeId: "existing.db",
      sqlite: again,
      databasePath,
      backupDir,
      isFreshStore: false,
      migrations,
      close: () => again.close(),
    });
    expect(secondRun.applied).toEqual([]);
    again.close();
    expect(listBackupFiles(backupDir, "existing.db")).toHaveLength(1);
  });

  it("迁移失败：整库恢复到备份内容并抛 MigrationFailureError", () => {
    const databasePath = join(workspace, "failing.db");
    const backupDir = join(workspace, "backups");
    const sqlite = openDatabase(databasePath);
    sqlite.exec("CREATE TABLE demo (id INTEGER PRIMARY KEY, value TEXT)");
    sqlite.prepare("INSERT INTO demo (value) VALUES ('keep-me')").run();
    sqlite.close();

    const reopened = openDatabase(databasePath);
    let caught: MigrationFailureError | undefined;
    try {
      runSqliteMigrations({
        storeId: "failing.db",
        sqlite: reopened,
        databasePath,
        backupDir,
        isFreshStore: false,
        migrations: [{
          version: 2,
          name: "will-fail",
          up: (ctx) => {
            ctx.sqlite.prepare("UPDATE demo SET value = 'mutated'").run();
            throw new Error("boom mid-migration");
          },
        }],
        close: () => reopened.close(),
      });
    } catch (error) {
      caught = error as MigrationFailureError;
    }
    expect(caught).toBeInstanceOf(MigrationFailureError);
    expect(caught?.failedName).toBe("will-fail");
    expect(caught?.backupPath).not.toBeNull();

    const verified = openDatabase(databasePath);
    expect(verified.prepare("SELECT value FROM demo").all()).toEqual([{ value: "keep-me" }]);
    expect(verified.prepare("SELECT MAX(version) AS version FROM data_migrations").get())
      .toEqual({ version: 1 });
    verified.close();

    const backup = new Database(caught!.backupPath!);
    expect(backup.prepare("SELECT value FROM demo").all()).toEqual([{ value: "keep-me" }]);
    backup.close();
  });

  it("备份保留策略：超出 keep 份的旧备份被清理", () => {
    const backupDir = join(workspace, "retention");
    const source = openDatabase(":memory:");
    source.exec("CREATE TABLE t (x)");
    for (let index = 1; index <= 8; index += 1) {
      vacuumIntoBackup(source, backupDir, "retention.db", index, index + 1);
    }
    source.close();
    expect(listBackupFiles(backupDir, "retention.db")).toHaveLength(8);
    pruneBackups(backupDir, "retention.db", 5);
    const remaining = listBackupFiles(backupDir, "retention.db");
    expect(remaining).toHaveLength(5);
    expect(remaining.map((path) => path.split("/").pop())).toEqual(
      [4, 5, 6, 7, 8].map((from) =>
        expect.stringMatching(new RegExp(`^retention\\.db-v${String(from)}-to-v${String(from + 1)}-`))
      ),
    );
  });
});
