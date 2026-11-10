-- P0-2h：删除记忆 / Room / 采集管线的 41 张表。
-- 对应模块（knowledge、context-rooms、memory、writing-style、ingest、clipper、
-- materials、perception、reality、screen-memory、diary、asr）已在 Phase 2 删除，
-- 这里清掉它们留下的空表。
--
-- 6 张被存活模块继续读取的表**不在**本迁移内（等 P0-2 documents 去 roomId 后再删）：
--   context_rooms（agent-access / documents / index-backfill）
--   rooms（search / documents.import）
--   room_doc_links（documents / agent / search / index-backfill）
--   room_overviews（agent-access）
--   room_source_memberships（search / agent-access）
--
-- 幂等：全部用 DROP TABLE IF EXISTS，可重复执行。
-- SQLite 的 DROP TABLE 会连带删除该表上的索引与触发器（本项目迁移里没有
-- CREATE VIEW / CREATE TRIGGER），因此无需先手工 DROP INDEX。
-- 顺序按外键依赖倒排（子表先删），避免 foreign_keys=ON 时隐式 DELETE 触发
-- 父表侧的约束校验。

-- 网页剪藏（clipper）：assets / artifacts 均外键指向 captures。
DROP TABLE IF EXISTS `clipper_artifacts`;--> statement-breakpoint
DROP TABLE IF EXISTS `clipper_assets`;--> statement-breakpoint
DROP TABLE IF EXISTS `clipper_captures`;--> statement-breakpoint

-- 日记（diary）：version_sources / runs 指向 versions，versions 指向 days。
DROP TABLE IF EXISTS `diary_version_sources`;--> statement-breakpoint
DROP TABLE IF EXISTS `diary_runs`;--> statement-breakpoint
DROP TABLE IF EXISTS `diary_versions`;--> statement-breakpoint
DROP TABLE IF EXISTS `diary_days`;--> statement-breakpoint
DROP TABLE IF EXISTS `diary_schedules`;--> statement-breakpoint

-- 屏幕记忆（screen-memory）与视觉观察（perception / reality 的产物表）。
DROP TABLE IF EXISTS `visual_observations`;--> statement-breakpoint
DROP TABLE IF EXISTS `visual_processing_jobs`;--> statement-breakpoint
DROP TABLE IF EXISTS `visual_nodes`;--> statement-breakpoint
DROP TABLE IF EXISTS `screen_keyframes`;--> statement-breakpoint
DROP TABLE IF EXISTS `screen_intervals`;--> statement-breakpoint
DROP TABLE IF EXISTS `perception_settings`;--> statement-breakpoint
DROP TABLE IF EXISTS `reality_events`;--> statement-breakpoint

-- 文件聚类（随 files/clustering-service.ts 一起退役）。
DROP TABLE IF EXISTS `file_cluster_memberships`;--> statement-breakpoint
DROP TABLE IF EXISTS `file_clusters`;--> statement-breakpoint

-- Room 合并 / 去重 / 记忆归属：merge_items 外键指向 merge_operations。
DROP TABLE IF EXISTS `room_merge_items`;--> statement-breakpoint
DROP TABLE IF EXISTS `room_merge_operations`;--> statement-breakpoint
DROP TABLE IF EXISTS `room_duplicate_candidates`;--> statement-breakpoint
DROP TABLE IF EXISTS `room_memory_attributions`;--> statement-breakpoint
DROP TABLE IF EXISTS `room_memory_suppressions`;--> statement-breakpoint

-- Room 知识图谱投影与任务夹 / 本地动作 / 纠错。
DROP TABLE IF EXISTS `room_relations`;--> statement-breakpoint
DROP TABLE IF EXISTS `room_entity_facts`;--> statement-breakpoint
DROP TABLE IF EXISTS `room_entity_mentions`;--> statement-breakpoint
DROP TABLE IF EXISTS `room_context_corrections`;--> statement-breakpoint
DROP TABLE IF EXISTS `room_local_actions`;--> statement-breakpoint
DROP TABLE IF EXISTS `room_folders`;--> statement-breakpoint
DROP TABLE IF EXISTS `room_wikis`;--> statement-breakpoint

-- 实体（knowledge 的实体抽取）与文档路由投影。
DROP TABLE IF EXISTS `entity_doc_links`;--> statement-breakpoint
DROP TABLE IF EXISTS `entities`;--> statement-breakpoint
DROP TABLE IF EXISTS `route_decisions`;--> statement-breakpoint
DROP TABLE IF EXISTS `route_mindmaps`;--> statement-breakpoint

-- 知识库偏好设置。
DROP TABLE IF EXISTS `knowledge_preferences`;--> statement-breakpoint
DROP TABLE IF EXISTS `knowledge_preference_settings`;--> statement-breakpoint

-- 写作风格画像（writing-style 模块）。
DROP TABLE IF EXISTS `writing_style_document_sketches`;--> statement-breakpoint
DROP TABLE IF EXISTS `writing_style_insights`;--> statement-breakpoint
DROP TABLE IF EXISTS `writing_style_profiles`;--> statement-breakpoint
DROP TABLE IF EXISTS `writing_style_settings`;--> statement-breakpoint
DROP TABLE IF EXISTS `writing_style_signals`;--> statement-breakpoint
DROP TABLE IF EXISTS `writing_style_user_content`;--> statement-breakpoint

-- 理解引擎台账：最后两处读取（files.purgeUnsupportedFiles 的清污删除、
-- connectors 连接级联的软删）已随本相位摘除，写入方更早随 ingest 模块删除。
DROP TABLE IF EXISTS `ingest_events`;
