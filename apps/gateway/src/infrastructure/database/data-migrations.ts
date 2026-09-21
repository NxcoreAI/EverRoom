import type { SqliteDataMigration } from "@nxcore/migration-kit";

/**
 * gateway.sqlite 的数据级迁移链（基线 v1 = 框架接管时的数据格式）。
 *
 * 表结构（DDL）变更继续走 drizzle-kit（apps/gateway/drizzle/），不要写在这里；
 * 这里只放「行级格式变换」——JSON blob 结构升级、字段语义重排、回填等。
 *
 * 新增迁移的规则：
 * - version 从 2 起严格递增；name 用 kebab-case 概括意图。
 * - up 必须幂等可重放（失败恢复后可能重跑），并容忍缺列/缺表的防御性写法
 *   （详见 client.ts 的历史 repair 与 migration-kit 的认领语义）。
 * - 不允许依赖 dataDir 内容（cursor-completion 实例以独立 dataDir 跑同一份链）。
 */
export const gatewayDataMigrations: readonly SqliteDataMigration[] = [
  {
    version: 2,
    name: "purge-saas-runtime-config",
    up: (ctx) => {
      // saas 运行时配置链路整体下线：清掉旧下发存储行与 saas 选中记录，
      // 让老库自然回落到内置默认源（user 源与其它 metadata 不动）。
      ctx.sqlite.prepare("DELETE FROM runtime_config_store WHERE source = 'saas'").run();
      ctx.sqlite
        .prepare("DELETE FROM gateway_metadata WHERE key = 'runtime_config_source' AND value = 'saas'")
        .run();
    },
  },
];
