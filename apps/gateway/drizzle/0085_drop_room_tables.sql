-- P0-2i：删除最后 5 张 Room 表。
-- 对应模块（context-rooms 及 Room 维度的 knowledge/memory 投影）已在 Phase 2 删除；
-- 0084 之后仍被存活模块读取的 5 张表，本相位已把所有读者摘干净：
--   -- agent-access / documents / index-backfill
--   context_rooms（agent-access 工具、documents 归属校验、index-backfill 扫描）
--   -- search / documents.import
--   rooms（search 索引与回填、documents.import 批量分类器）
--   -- documents / agent / search / index-backfill
--   room_doc_links（documents 列表与块引用、agent 引用视图、search 归属、index-backfill）
--   -- agent-access
--   room_overviews（agent-access 工具读概览）
--   -- search / agent-access
--   room_source_memberships（search 文件归属、agent-access 文件范围与规则工具）
--
-- 幂等：全部用 DROP TABLE IF EXISTS，可重复执行。
-- SQLite 的 DROP TABLE 会连带删除该表上的索引与触发器（本项目迁移里没有
-- CREATE VIEW / CREATE TRIGGER），因此无需先手工 DROP INDEX。
-- 顺序按外键依赖倒排（子表先删，父表后删：room_overviews 指向 context_rooms），
-- 避免 foreign_keys=ON 时隐式 DELETE 触发父表侧的约束校验。
DROP TABLE IF EXISTS `room_doc_links`;--> statement-breakpoint
DROP TABLE IF EXISTS `room_overviews`;--> statement-breakpoint
DROP TABLE IF EXISTS `room_source_memberships`;--> statement-breakpoint
DROP TABLE IF EXISTS `context_rooms`;--> statement-breakpoint
DROP TABLE IF EXISTS `rooms`;