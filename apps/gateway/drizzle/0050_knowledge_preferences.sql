CREATE TABLE IF NOT EXISTS `knowledge_preferences` (
	`owner_id` text PRIMARY KEY NOT NULL DEFAULT 'local-user',
	`stats_json` text,
	`insight` text,
	`user_preference` text NOT NULL DEFAULT '',
	`user_edited` integer NOT NULL DEFAULT false,
	`llm_material_cursor` text,
	`last_refreshed_at` integer,
	`last_llm_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `knowledge_preference_settings` (
	`owner_id` text PRIMARY KEY NOT NULL DEFAULT 'local-user',
	`learning_enabled` integer NOT NULL DEFAULT true,
	`injection_enabled` integer NOT NULL DEFAULT true,
	`config_version` integer NOT NULL DEFAULT 1,
	`updated_at` integer NOT NULL
);
