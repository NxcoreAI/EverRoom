-- 写作路线导图（聚焦改版 2026-09）：新文档创建时的路线选择图，一行一文档。
-- 全图（含未选分支与回退历史）记在 graph，展示层按 selection_path 过滤；
-- 拍板（finalize）后锁只读并派 doc-writer 写正文。
CREATE TABLE `route_mindmaps` (
	`document_id` text PRIMARY KEY,
	`room_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL DEFAULT 'expanding',
	`graph` text,
	`selection_path` text,
	`expanding_node_ref` text,
	`skipped` integer,
	`writing` integer,
	`error` text,
	`prompt_version` integer,
	`generation_key` text,
	`writing_key` text,
	`content_hash` text,
	`finalized_at` integer,
	`generated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `route_mindmaps_room_idx` ON `route_mindmaps` (`room_id`);
--> statement-breakpoint
-- 聚焦旧链路整体废弃：打开文档生成内容导图改为创建文档时的路线导图（route_mindmaps）。
DROP TABLE IF EXISTS `focus_mindmaps`;
