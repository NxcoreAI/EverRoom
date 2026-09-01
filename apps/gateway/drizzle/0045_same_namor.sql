-- Idempotent on purpose: pre-merge reconciliation tests re-run late migrations.
CREATE TABLE IF NOT EXISTS `writing_style_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`document_id` text,
	`room_id` text,
	`instruction` text,
	`category` text,
	`before` text,
	`after` text,
	`delta_meta` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `writing_style_signals_type_idx` ON `writing_style_signals` (`type`);