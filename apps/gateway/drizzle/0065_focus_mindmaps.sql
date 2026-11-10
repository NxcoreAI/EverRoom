-- 聚焦思维导图（思路板块聚焦模式改造）：subAgent 生成的 NotebookLM 式三层导图。
-- 按焦点两级缓存：document 级（单文档全文）与 room 级（Room 内全部文档）。
-- 复合主键而非唯一索引：SQLite 唯一索引把 NULL 视为互异，scope 两级共用一表更稳。
CREATE TABLE `focus_mindmaps` (
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`room_id` text NOT NULL,
	`document_title` text,
	`status` text NOT NULL DEFAULT 'pending',
	`tree` text,
	`error` text,
	`prompt_version` integer,
	`invocation_key` text,
	`content_hash` text,
	`generated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`scope`, `scope_id`)
);
--> statement-breakpoint
CREATE INDEX `focus_mindmaps_room_idx` ON `focus_mindmaps` (`room_id`);
