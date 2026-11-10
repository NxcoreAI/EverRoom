import type { SqliteDataMigration } from "@nxcore/migration-kit";

/**
 * nxcore.db 的版本化迁移链（基线 v1 = 框架接管时的 schema）。
 *
 * initialize() 里现有的 PRAGMA 探测式补列/重建是历史兼容层，原样保留且永远
 * 先于本链执行；此后新的 schema/数据变更一律在此追加版本化迁移（v2 起）。
 * up 必须幂等可重放。evidence_* 表由 EvidenceService 共管，涉及时同样走这里。
 */
export const nxcoreDataMigrations: readonly SqliteDataMigration[] = [];
