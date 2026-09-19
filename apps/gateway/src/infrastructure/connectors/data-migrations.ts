import type { SqliteDataMigration } from "@nxcore/migration-kit";

/**
 * connectors.sqlite 的版本化迁移链（基线 v1 = 框架接管时的 schema）。
 *
 * client.ts 里现有的 migrate() 探测式补列是历史兼容层，原样保留且永远
 * 先于本链执行；此后新的 schema/数据变更一律在此追加版本化迁移（v2 起），
 * 不再往 migrate() 里加探测分支。
 *
 * up 必须幂等可重放；不允许依赖 dataDir 内容。
 */
export const connectorDataMigrations: readonly SqliteDataMigration[] = [];
