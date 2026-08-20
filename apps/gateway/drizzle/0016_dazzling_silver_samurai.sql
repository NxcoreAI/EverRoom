CREATE TABLE `connector_prompt_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`service` text NOT NULL,
	`resource_type` text NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`template` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`content_hash` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_prompt_profiles_service_version_idx` ON `connector_prompt_profiles` (`service`,`resource_type`,`version`);--> statement-breakpoint
CREATE INDEX `connector_prompt_profiles_status_idx` ON `connector_prompt_profiles` (`status`,`service`);--> statement-breakpoint
CREATE TABLE `connector_sync_job_states` (
	`job_id` text PRIMARY KEY NOT NULL,
	`checkpoint` text,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_success_at` integer,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `connector_sync_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `connector_sync_job_states_due_idx` ON `connector_sync_job_states` (`next_run_at`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `connector_sync_job_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`version` integer NOT NULL,
	`config_snapshot` text NOT NULL,
	`changed_by` text NOT NULL,
	`change_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `connector_sync_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_sync_job_versions_job_version_idx` ON `connector_sync_job_versions` (`job_id`,`version`);--> statement-breakpoint
ALTER TABLE `connector_accounts` ADD `display_name` text;--> statement-breakpoint
ALTER TABLE `connector_accounts` ADD `account_label` text;--> statement-breakpoint
ALTER TABLE `connector_accounts` ADD `credential_ref` text;--> statement-breakpoint
ALTER TABLE `connector_sync_jobs` ADD `name` text DEFAULT 'Connector sync' NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_sync_jobs` ADD `prompt_profile_id` text REFERENCES connector_prompt_profiles(id);--> statement-breakpoint
ALTER TABLE `connector_sync_jobs` ADD `prompt_override` text;--> statement-breakpoint
ALTER TABLE `connector_sync_jobs` ADD `schedule_type` text DEFAULT 'interval' NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_sync_jobs` ADD `timezone` text DEFAULT 'Asia/Shanghai' NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_sync_jobs` ADD `retry_policy` text DEFAULT '{"maxAttempts":3,"baseDelayMs":30000}' NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_sync_jobs` ADD `priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_sync_jobs` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_sync_jobs` ADD `config_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_sync_runs` ADD `job_version_id` text REFERENCES connector_sync_job_versions(id);--> statement-breakpoint
ALTER TABLE `connector_sync_runs` ADD `unchanged` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_sync_runs` ADD `quarantined` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_sync_runs` ADD `rendered_prompt_hash` text;--> statement-breakpoint
ALTER TABLE `connector_sync_runs` ADD `prompt_profile_version` integer;--> statement-breakpoint
ALTER TABLE `connector_sync_runs` ADD `input_checkpoint` text;--> statement-breakpoint
ALTER TABLE `connector_sync_runs` ADD `output_checkpoint` text;