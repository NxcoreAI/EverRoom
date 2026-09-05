-- 格式映射体系：provider 原始格式 → canonical schema 的 JSONata 映射（缓存复用）。
-- 每 (service, record_kind) 一行；agent 首次见到该格式时后台生成，之后同步直通。
CREATE TABLE IF NOT EXISTS `connector_format_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`service` text NOT NULL,
	`record_kind` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`mapping_json` text,
	`samples_json` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`activated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `connector_format_mappings_service_kind_idx` ON `connector_format_mappings` (`service`,`record_kind`);
