-- 文档本地评论：用户在评论面板手动添加，支持回复（parent_id）与解决状态；
-- 与外部导入评论（document_import_comments）共用同一面板，导入侧只读。
CREATE TABLE IF NOT EXISTS `document_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	`parent_id` text,
	`block_id` text,
	`quoted_text` text,
	`body` text NOT NULL,
	`author_name` text NOT NULL DEFAULT '我',
	`resolved` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_comments_document_idx` ON `document_comments` (`document_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_comments_parent_idx` ON `document_comments` (`parent_id`);
