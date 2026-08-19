CREATE TABLE `connector_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`service` text NOT NULL,
	`connection_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_accounts_owner_service_connection_idx` ON `connector_accounts` (`owner_id`,`service`,`connection_name`);--> statement-breakpoint
CREATE INDEX `connector_accounts_owner_idx` ON `connector_accounts` (`owner_id`);--> statement-breakpoint
CREATE TABLE `connector_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`request_id` text NOT NULL,
	`actor` text NOT NULL,
	`operation` text NOT NULL,
	`effect` text NOT NULL,
	`result` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connector_audit_events_owner_created_idx` ON `connector_audit_events` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `connector_audit_events_request_idx` ON `connector_audit_events` (`request_id`);--> statement-breakpoint
CREATE TABLE `connector_records` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`service` text NOT NULL,
	`dataset` text NOT NULL,
	`source_record_id` text NOT NULL,
	`payload` text NOT NULL,
	`source_updated_at` integer,
	`content_hash` text NOT NULL,
	`synced_at` integer NOT NULL,
	`expires_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_records_owner_source_idx` ON `connector_records` (`owner_id`,`service`,`dataset`,`source_record_id`);--> statement-breakpoint
CREATE INDEX `connector_records_owner_dataset_idx` ON `connector_records` (`owner_id`,`dataset`);--> statement-breakpoint
CREATE INDEX `connector_records_synced_idx` ON `connector_records` (`synced_at`);--> statement-breakpoint
CREATE TABLE `connector_sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`service` text NOT NULL,
	`action` text NOT NULL,
	`dataset` text NOT NULL,
	`connection_name` text,
	`input` text NOT NULL,
	`interval_ms` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_success_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connector_sync_jobs_due_idx` ON `connector_sync_jobs` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `connector_sync_jobs_owner_idx` ON `connector_sync_jobs` (`owner_id`);--> statement-breakpoint
CREATE TABLE `connector_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`status` text NOT NULL,
	`cursor` text,
	`discovered` integer DEFAULT 0 NOT NULL,
	`inserted` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `connector_sync_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `connector_sync_runs_job_started_idx` ON `connector_sync_runs` (`job_id`,`started_at`);