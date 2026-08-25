CREATE TABLE `clipper_artifacts` (
	`capture_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`display_markdown` text NOT NULL,
	`semantic_markdown` text NOT NULL,
	`excerpt` text DEFAULT '' NOT NULL,
	`cover_asset_id` text,
	`parse_status` text DEFAULT 'pending' NOT NULL,
	`visual_status` text DEFAULT 'pending' NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`capture_id`) REFERENCES `clipper_captures`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `clipper_assets` ADD `visual_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `clipper_assets` ADD `visual_kind` text;--> statement-breakpoint
ALTER TABLE `clipper_assets` ADD `visual_summary` text;--> statement-breakpoint
ALTER TABLE `clipper_assets` ADD `visual_ocr_text` text;--> statement-breakpoint
ALTER TABLE `clipper_assets` ADD `visual_key_points` text;--> statement-breakpoint
ALTER TABLE `clipper_assets` ADD `visual_entities` text;--> statement-breakpoint
ALTER TABLE `clipper_assets` ADD `visual_relevance` real;--> statement-breakpoint
ALTER TABLE `clipper_assets` ADD `visual_quality` real;--> statement-breakpoint
ALTER TABLE `clipper_assets` ADD `visual_model` text;--> statement-breakpoint
ALTER TABLE `clipper_assets` ADD `visual_prompt_version` text;--> statement-breakpoint
ALTER TABLE `clipper_assets` ADD `cover_score` real;