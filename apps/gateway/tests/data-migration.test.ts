import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { MigrationFailureError, runSqliteMigrations } from "@nxcore/migration-kit";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { createConnectorDatabase } from "../src/infrastructure/connectors/client.js";

const migrationsDir = fileURLToPath(new URL("../drizzle", import.meta.url));

let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "gateway-data-migration-"));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("gateway.sqlite 迁移框架接入", () => {
  it("全新库：createDatabase 完整跑通 repair/drizzle 链并认领基线 v1", () => {
    const databasePath = join(workspace, "fresh", "database", "gateway.sqlite");
    const { sqlite } = createDatabase(databasePath, migrationsDir);
    const claim = sqlite
      .prepare("SELECT version, name, via FROM data_migrations")
      .all() as Array<{ version: number; name: string; via: string }>;
    expect(claim).toEqual([
      { version: 1, name: "baseline", via: "fresh-claim" },
      { version: 2, name: "purge-saas-runtime-config", via: "fresh-claim" },
    ]);
    sqlite.close();
  });

  it("存量库（无版本记录）：认领基线后执行 v2 数据迁移并生成备份", () => {
    const databasePath = join(workspace, "existing", "database", "gateway.sqlite");
    const { sqlite } = createDatabase(databasePath, migrationsDir);
    sqlite.close();

    // 模拟框架接管前的老库：清掉版本记录，塞一行旧格式业务数据。
    const legacy = new Database(databasePath);
    legacy.prepare("DELETE FROM data_migrations").run();
    legacy
      .prepare("INSERT INTO gateway_metadata (key, value, updated_at) VALUES ('probe', 'legacy-value', 0)")
      .run();
    legacy.close();

    const reopened = new Database(databasePath);
    reopened.pragma("journal_mode = WAL");
    const result = runSqliteMigrations({
      storeId: "gateway.sqlite",
      sqlite: reopened,
      databasePath,
      backupDir: join(workspace, "existing", "backups"),
      isFreshStore: false,
      migrations: [{
        version: 2,
        name: "probe-rewrite",
        up: (ctx) => {
          ctx.sqlite
            .prepare("UPDATE gateway_metadata SET value = 'migrated:' || value WHERE key = 'probe'")
            .run();
        },
      }],
      close: () => reopened.close(),
    });
    expect(result.applied.map((item) => item.version)).toEqual([2]);
    expect(result.backupPath).not.toBeNull();
    expect(
      reopened.prepare("SELECT value FROM gateway_metadata WHERE key = 'probe'").get(),
    ).toEqual({ value: "migrated:legacy-value" });
    reopened.close();
  });

  it("v2 清除 saas 运行时配置行与 saas 选中记录，user 行与其它 metadata 保留", () => {
    const databasePath = join(workspace, "purge", "database", "gateway.sqlite");
    const { sqlite } = createDatabase(databasePath, migrationsDir);
    sqlite.close();

    // 模拟旧版桌面留下的库：saas 下发行、saas 选中记录 + 无关数据。
    const legacy = new Database(databasePath);
    legacy.prepare("DELETE FROM data_migrations").run();
    legacy
      .prepare("INSERT INTO runtime_config_store (source, payload, schema_version, config_version, updated_at) VALUES ('saas', '{}', 1, 3, 0)")
      .run();
    legacy
      .prepare("INSERT INTO runtime_config_store (source, payload, schema_version, config_version, updated_at) VALUES ('user', '{}', 1, 2, 0)")
      .run();
    legacy
      .prepare("INSERT INTO gateway_metadata (key, value, updated_at) VALUES ('runtime_config_source', 'saas', 0)")
      .run();
    legacy
      .prepare("INSERT INTO gateway_metadata (key, value, updated_at) VALUES ('unrelated', 'keep', 0)")
      .run();
    legacy.close();

    const reopened = createDatabase(databasePath, migrationsDir);
    expect(
      reopened.sqlite.prepare("SELECT source FROM runtime_config_store").all(),
    ).toEqual([{ source: "user" }]);
    expect(
      reopened.sqlite.prepare("SELECT value FROM gateway_metadata WHERE key = 'runtime_config_source'").get(),
    ).toBeUndefined();
    expect(
      reopened.sqlite.prepare("SELECT value FROM gateway_metadata WHERE key = 'unrelated'").get(),
    ).toEqual({ value: "keep" });
    const claim = reopened.sqlite
      .prepare("SELECT version, name, via FROM data_migrations")
      .all() as Array<{ version: number; name: string; via: string }>;
    expect(claim).toEqual([
      { version: 1, name: "baseline", via: "baseline-claim" },
      { version: 2, name: "purge-saas-runtime-config", via: "migration" },
    ]);
    reopened.sqlite.close();
  });

  it("存量库迁移失败：整库恢复到备份内容（WAL 文件一并清理）", () => {
    const databasePath = join(workspace, "failing", "database", "gateway.sqlite");
    const { sqlite } = createDatabase(databasePath, migrationsDir);
    sqlite.close();

    const legacy = new Database(databasePath);
    legacy.prepare("DELETE FROM data_migrations").run();
    legacy
      .prepare("INSERT INTO gateway_metadata (key, value, updated_at) VALUES ('probe', 'keep', 0)")
      .run();
    legacy.close();

    const reopened = new Database(databasePath);
    reopened.pragma("journal_mode = WAL");
    let caught: MigrationFailureError | undefined;
    try {
      runSqliteMigrations({
        storeId: "gateway.sqlite",
        sqlite: reopened,
        databasePath,
        backupDir: join(workspace, "failing", "backups"),
        isFreshStore: false,
        migrations: [{
          version: 2,
          name: "probe-explode",
          up: (ctx) => {
            ctx.sqlite
              .prepare("UPDATE gateway_metadata SET value = 'mutated' WHERE key = 'probe'")
              .run();
            throw new Error("mid-migration failure");
          },
        }],
        close: () => reopened.close(),
      });
    } catch (error) {
      caught = error as MigrationFailureError;
    }
    expect(caught).toBeInstanceOf(MigrationFailureError);
    const verified = new Database(databasePath);
    expect(
      verified.prepare("SELECT value FROM gateway_metadata WHERE key = 'probe'").get(),
    ).toEqual({ value: "keep" });
    expect(
      verified.prepare("SELECT MAX(version) AS version FROM data_migrations").get(),
    ).toEqual({ version: 1 });
    verified.close();
  });
});

describe("connectors.sqlite 迁移框架接入", () => {
  it("全新库：建表 + 探测层 + 认领基线 v1", () => {
    const databasePath = join(workspace, "connectors", "connectors.sqlite");
    mkdirSync(join(workspace, "connectors"), { recursive: true });
    const { sqlite, close } = createConnectorDatabase(databasePath);
    const claim = sqlite
      .prepare("SELECT version, name, via FROM data_migrations")
      .all() as Array<{ version: number; name: string; via: string }>;
    expect(claim).toEqual([{ version: 1, name: "baseline", via: "fresh-claim" }]);
    close();
  });

  it("老库（缺列 + 旧列名）：探测层补齐 schema 后认领基线", () => {
    const databasePath = join(workspace, "connectors-legacy", "connectors.sqlite");
    mkdirSync(join(workspace, "connectors-legacy"), { recursive: true });
    // 造一个「阶段三之前」的旧形态：nango_config_key/nango_connection_id 列名。
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        nango_config_key TEXT NOT NULL,
        nango_connection_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        filters_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(nango_config_key, nango_connection_id)
      );
    `);
    legacy
      .prepare(
        "INSERT INTO connector_connections (id, provider, nango_config_key, nango_connection_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("c1", "google-mail", "gmail", "conn-1", "2026-01-01", "2026-01-01");
    legacy.close();

    const { sqlite, close } = createConnectorDatabase(databasePath);
    const columns = (sqlite.prepare("PRAGMA table_info(connector_connections)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toContain("service");
    expect(columns).toContain("auth_method");
    expect(
      sqlite.prepare("SELECT service FROM connector_connections WHERE id = 'c1'").get(),
    ).toEqual({ service: "gmail" });
    const claim = sqlite
      .prepare("SELECT version, via FROM data_migrations")
      .all() as Array<{ version: number; via: string }>;
    expect(claim).toEqual([{ version: 1, via: "baseline-claim" }]);
    close();
  });
});
