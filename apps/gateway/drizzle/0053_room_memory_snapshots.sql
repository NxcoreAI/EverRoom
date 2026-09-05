-- Room 记忆内容快照（限定 Room 记忆注入的数据源）。
-- MemoryCore 无按 id 批量取数 API，注入与 memory_search 的 room 过滤
-- 都读归属表快照列；绑定时写入、编辑记忆时刷新。
ALTER TABLE `room_memory_attributions` ADD `content` text;--> statement-breakpoint
ALTER TABLE `room_memory_attributions` ADD `memory_type` text;--> statement-breakpoint
ALTER TABLE `room_memory_attributions` ADD `memory_updated_at` text;
