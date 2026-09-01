-- Idempotent on purpose: pre-merge reconciliation tests re-run late migrations
-- after their markers were stripped (same philosophy as client.ts additive repairs).
CREATE TABLE IF NOT EXISTS `writing_style_document_sketches` (
	`document_id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`source_version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`excluded` integer DEFAULT false NOT NULL,
	`char_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`stats_json` text,
	`truncated` integer DEFAULT false NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`extracted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `writing_style_sketches_status_idx` ON `writing_style_document_sketches` (`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `writing_style_profiles` (
	`owner_id` text PRIMARY KEY DEFAULT 'local-user' NOT NULL,
	`profile_version` integer DEFAULT 0 NOT NULL,
	`stats_json` text,
	`qualitative_json` text,
	`digest_completion` text,
	`digest_generation` text,
	`sample_document_count` integer DEFAULT 0 NOT NULL,
	`sample_char_count` integer DEFAULT 0 NOT NULL,
	`confidence_tier` text DEFAULT 'empty' NOT NULL,
	`last_refreshed_at` integer,
	`last_llm_at` integer,
	`llm_material_cursor` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `writing_style_settings` (
	`owner_id` text PRIMARY KEY DEFAULT 'local-user' NOT NULL,
	`completion_enabled` integer DEFAULT false NOT NULL,
	`generation_enabled` integer DEFAULT false NOT NULL,
	`config_version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `writing_style_user_content` (
	`owner_id` text PRIMARY KEY DEFAULT 'local-user' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`user_edited` integer DEFAULT false NOT NULL,
	`generated_from_cursor` text,
	`updated_at` integer NOT NULL
);
