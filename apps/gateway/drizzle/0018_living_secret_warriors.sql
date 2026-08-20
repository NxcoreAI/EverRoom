CREATE TABLE `diary_days` (
	`date` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_version_id` text,
	`source_fingerprint` text,
	`event_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `diary_days_status_date_idx` ON `diary_days` (`status`,`date`);--> statement-breakpoint
CREATE TABLE `diary_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`window_start` integer NOT NULL,
	`window_end` integer NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`error` text,
	`version_id` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`date`) REFERENCES `diary_days`(`date`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `diary_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `diary_runs_due_idx` ON `diary_runs` (`status`,`next_attempt_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `diary_runs_date_idx` ON `diary_runs` (`date`,`created_at`);--> statement-breakpoint
CREATE TABLE `diary_schedules` (
	`owner_id` text PRIMARY KEY DEFAULT 'local-user' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`local_time` text DEFAULT '23:30' NOT NULL,
	`timezone` text NOT NULL,
	`enabled_from` text,
	`next_run_at` integer,
	`config_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `diary_version_sources` (
	`version_id` text NOT NULL,
	`source_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_version` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`content_fingerprint` text NOT NULL,
	`evidence_summary` text NOT NULL,
	`asset_file_id` text,
	PRIMARY KEY(`version_id`, `source_id`),
	FOREIGN KEY (`version_id`) REFERENCES `diary_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_file_id`) REFERENCES `uploaded_files`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `diary_version_sources_source_idx` ON `diary_version_sources` (`source_kind`,`source_id`);--> statement-breakpoint
CREATE TABLE `diary_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`window_start` integer NOT NULL,
	`window_end` integer NOT NULL,
	`source_fingerprint` text NOT NULL,
	`agent_model` text,
	`prompt_version` integer DEFAULT 1 NOT NULL,
	`run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`date`) REFERENCES `diary_days`(`date`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diary_versions_date_version_idx` ON `diary_versions` (`date`,`version`);--> statement-breakpoint
CREATE TABLE `perception_settings` (
	`owner_id` text PRIMARY KEY DEFAULT 'local-user' NOT NULL,
	`capture_enabled` integer DEFAULT false NOT NULL,
	`capture_interval_seconds` integer DEFAULT 300 NOT NULL,
	`online_vlm_enabled` integer DEFAULT false NOT NULL,
	`config_version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `visual_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`sample_count` integer DEFAULT 1 NOT NULL,
	`representative_observation_id` text,
	`latest_perceptual_hash` text,
	`vlm_status` text DEFAULT 'disabled' NOT NULL,
	`event_type` text,
	`title` text,
	`summary` text,
	`key_points` text DEFAULT '[]' NOT NULL,
	`representative_tags` text DEFAULT '[]' NOT NULL,
	`confidence` real,
	`model` text,
	`prompt_version` integer DEFAULT 1 NOT NULL,
	`result_version` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `visual_nodes_range_idx` ON `visual_nodes` (`start_at`,`end_at`);--> statement-breakpoint
CREATE INDEX `visual_nodes_status_idx` ON `visual_nodes` (`vlm_status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `visual_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`file_id` text NOT NULL,
	`kind` text NOT NULL,
	`captured_at` integer NOT NULL,
	`perceptual_hash` text,
	`width` integer,
	`height` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `visual_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `uploaded_files`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visual_observations_file_idx` ON `visual_observations` (`file_id`);--> statement-breakpoint
CREATE INDEX `visual_observations_node_captured_idx` ON `visual_observations` (`node_id`,`captured_at`);--> statement-breakpoint
CREATE INDEX `visual_observations_captured_idx` ON `visual_observations` (`captured_at`);--> statement-breakpoint
CREATE TABLE `visual_processing_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `visual_nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visual_processing_jobs_node_idx` ON `visual_processing_jobs` (`node_id`);--> statement-breakpoint
CREATE INDEX `visual_processing_jobs_due_idx` ON `visual_processing_jobs` (`status`,`next_attempt_at`,`lease_expires_at`);--> statement-breakpoint
ALTER TABLE `uploaded_files` ADD `asset_kind` text DEFAULT 'document' NOT NULL;--> statement-breakpoint
ALTER TABLE `uploaded_files` ADD `origin_channel` text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE `uploaded_files` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE `uploaded_files` ADD `captured_at` integer;