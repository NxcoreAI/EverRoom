-- 连接器改造：从同步管道到 Agent 即席检索。
-- 1) 新增「已断开」墓碑表（本地只保留可见性状态，不存连接器内容）。
-- 2) 删除同步时代的域表、格式映射、markdown outbox 与旧 CLI 连接器表。
-- 全部幂等（IF NOT EXISTS / IF EXISTS），可重复执行。
-- 顺序按外键依赖倒排：先删引用方，再删被引用表。

CREATE TABLE IF NOT EXISTS `connector_tombstones` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `service` text NOT NULL,
  `connection_name` text NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `connector_tombstones_owner_service_connection_idx` ON `connector_tombstones` (`owner_id`,`service`,`connection_name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `connector_tombstones_owner_idx` ON `connector_tombstones` (`owner_id`);--> statement-breakpoint
DROP TABLE IF EXISTS `connector_quarantined_records`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_sync_runs`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_sync_job_states`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_sync_job_versions`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_sync_jobs`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_prompt_profiles`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_markdown_outbox`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_markdown_artifacts`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_format_mappings`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_documents`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_todos`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_calendar_events`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_emails`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_records`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_audit_events`;--> statement-breakpoint
DROP TABLE IF EXISTS `connector_accounts`;
