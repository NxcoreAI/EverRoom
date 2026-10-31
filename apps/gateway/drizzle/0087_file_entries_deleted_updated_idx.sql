-- 文件页卡死 / 健康检查超时（/v1/health/ready 10s ECONNABORTED）的根因修复。
--
-- `/v1/files/catalog` 的分页查询是
--   WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?
-- 缺索引时 SQLite 只能 SCAN file_entries 再 USE TEMP B-TREE FOR ORDER BY：17k 条目的
-- 实测库里单页 44–282ms，且 better-sqlite3 是同步的——全部落在网关主线程上。
-- 桌面文件页（FilesPage.loadFiles）在全量刷新时按 200/页 把**所有**剩余页并发拉取，
-- 17k 条目即 87 个并发请求：主线程被连续占满 36s（冷缓存 55s），期间 10s 的
-- `/v1/health/ready` 取不到事件循环，桌面端记录 ECONNABORTED 超时并反复重启网关，
-- 用户侧表现就是文件界面卡死。
--
-- (deleted_at, updated_at DESC) 让同一条查询退化成按索引倒序扫描，只读 limit+offset 行：
-- 单页降到 <2ms，87 页并发从 36s 降到 ~3s，健康检查恢复亚秒级。
--
-- 幂等：CREATE INDEX IF NOT EXISTS，可重复执行。
CREATE INDEX IF NOT EXISTS `file_entries_deleted_updated_idx`
  ON `file_entries` (`deleted_at`, `updated_at` DESC);
