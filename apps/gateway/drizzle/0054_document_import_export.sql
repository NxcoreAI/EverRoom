-- 外部文档导入与 Agent 一次性导出（feishu-notion-document-export-plan.md）。
-- 导入：来源登记 / 导入任务 / 不可变快照（正文与评论在 files sha256 CAS，表内
-- 只留 artifact 引用）/ 评论记录 / Room 关联（relation=candidate 为再次导入候选，
-- 不覆盖当前版本）。导出：agent_document_exports 只做审计，不建远端 binding，
-- 授权 challenge 不入库（Desktop 本地控制器持有）。
CREATE TABLE IF NOT EXISTS `document_import_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL DEFAULT 'local-user',
	`provider` text NOT NULL,
	`remote_document_id` text NOT NULL,
	`source_url` text,
	`display_title` text,
	`external_account_ref` text,
	`last_seen_revision` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `document_import_sources_owner_remote_idx` ON `document_import_sources` (`owner_id`,`provider`,`remote_document_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_import_sources_provider_idx` ON `document_import_sources` (`provider`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `document_import_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`owner_id` text NOT NULL DEFAULT 'local-user',
	`provider` text NOT NULL,
	`source_id` text REFERENCES `document_import_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	`remote_document_id` text NOT NULL,
	`target_room_id` text,
	`target_document_id` text,
	`action_refs_json` text NOT NULL DEFAULT '[]',
	`snapshot_id` text,
	`status` text NOT NULL DEFAULT 'searching',
	`warnings_json` text NOT NULL DEFAULT '[]',
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_import_runs_owner_created_idx` ON `document_import_runs` (`owner_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_import_runs_source_idx` ON `document_import_runs` (`source_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_import_runs_target_idx` ON `document_import_runs` (`target_room_id`,`target_document_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `document_import_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL REFERENCES `document_import_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	`import_run_id` text NOT NULL REFERENCES `document_import_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	`artifact_ref` text NOT NULL,
	`content_hash` text NOT NULL,
	`source_revision` text,
	`comments_status` text NOT NULL,
	`comments_hash` text,
	`captured_at` integer NOT NULL,
	`warnings_json` text NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_import_snapshots_source_idx` ON `document_import_snapshots` (`source_id`,`captured_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_import_snapshots_run_idx` ON `document_import_snapshots` (`import_run_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_import_snapshots_content_idx` ON `document_import_snapshots` (`content_hash`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `document_import_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL REFERENCES `document_import_snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	`remote_comment_id` text NOT NULL,
	`parent_remote_comment_id` text,
	`author_json` text,
	`body` text NOT NULL,
	`quoted_text` text,
	`anchor_json` text,
	`status` text NOT NULL DEFAULT 'unknown',
	`source_url` text,
	`location_status` text NOT NULL DEFAULT 'unlocated',
	`comment_created_at` integer,
	`comment_updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `document_import_comments_snapshot_remote_idx` ON `document_import_comments` (`snapshot_id`,`remote_comment_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_import_comments_snapshot_idx` ON `document_import_comments` (`snapshot_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `document_room_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`document_id` text NOT NULL REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	`import_run_id` text NOT NULL REFERENCES `document_import_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	`snapshot_id` text NOT NULL REFERENCES `document_import_snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	`imported_version` integer,
	`relation` text NOT NULL DEFAULT 'primary',
	`candidate_document_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_room_imports_room_document_idx` ON `document_room_imports` (`room_id`,`document_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_room_imports_run_idx` ON `document_room_imports` (`import_run_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_document_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`owner_id` text NOT NULL DEFAULT 'local-user',
	`room_id` text NOT NULL,
	`document_id` text NOT NULL REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	`version` integer NOT NULL,
	`provider` text NOT NULL,
	`mode` text NOT NULL,
	`target_json` text,
	`renderer_version` text,
	`payload_hash` text,
	`payload_markdown_ref` text,
	`cli_skill_ref` text,
	`status` text NOT NULL DEFAULT 'preparing',
	`challenge_json` text,
	`confirmation_json` text,
	`remote_result_json` text,
	`warnings_json` text NOT NULL DEFAULT '[]',
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_document_exports_owner_created_idx` ON `agent_document_exports` (`owner_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_document_exports_document_idx` ON `agent_document_exports` (`document_id`);
