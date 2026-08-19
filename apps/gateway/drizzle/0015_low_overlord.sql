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
CREATE TABLE `connector_calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`service` text NOT NULL,
	`connection_name` text,
	`source_record_id` text NOT NULL,
	`source_updated_at` integer,
	`synced_at` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`prompt_version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`extension_payload` text,
	`deleted_at` integer,
	`event_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`organizer` text,
	`attendees` text NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`all_day` integer DEFAULT false NOT NULL,
	`status` text,
	`location` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_calendar_events_owner_source_idx` ON `connector_calendar_events` (`owner_id`,`service`,`connection_name`,`source_record_id`);--> statement-breakpoint
CREATE INDEX `connector_calendar_events_owner_start_idx` ON `connector_calendar_events` (`owner_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `connector_calendar_events_owner_event_idx` ON `connector_calendar_events` (`owner_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `connector_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`service` text NOT NULL,
	`connection_name` text,
	`source_record_id` text NOT NULL,
	`source_updated_at` integer,
	`synced_at` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`prompt_version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`extension_payload` text,
	`deleted_at` integer,
	`document_id` text NOT NULL,
	`title` text NOT NULL,
	`owner_name` text,
	`document_type` text,
	`body_text` text NOT NULL,
	`source_url` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_documents_owner_source_idx` ON `connector_documents` (`owner_id`,`service`,`connection_name`,`source_record_id`);--> statement-breakpoint
CREATE INDEX `connector_documents_owner_updated_idx` ON `connector_documents` (`owner_id`,`source_updated_at`);--> statement-breakpoint
CREATE INDEX `connector_documents_owner_document_idx` ON `connector_documents` (`owner_id`,`document_id`);--> statement-breakpoint
CREATE TABLE `connector_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`service` text NOT NULL,
	`connection_name` text,
	`source_record_id` text NOT NULL,
	`source_updated_at` integer,
	`synced_at` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`prompt_version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`extension_payload` text,
	`deleted_at` integer,
	`message_id` text NOT NULL,
	`thread_id` text,
	`sender_name` text,
	`sender_address` text,
	`recipients` text NOT NULL,
	`subject` text NOT NULL,
	`sent_at` integer,
	`body_text` text NOT NULL,
	`labels` text NOT NULL,
	`has_attachments` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_emails_owner_source_idx` ON `connector_emails` (`owner_id`,`service`,`connection_name`,`source_record_id`);--> statement-breakpoint
CREATE INDEX `connector_emails_owner_sent_idx` ON `connector_emails` (`owner_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `connector_emails_owner_sender_idx` ON `connector_emails` (`owner_id`,`sender_address`);--> statement-breakpoint
CREATE INDEX `connector_emails_owner_message_idx` ON `connector_emails` (`owner_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `connector_quarantined_records` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`job_id` text NOT NULL,
	`run_id` text NOT NULL,
	`source_record_id` text,
	`reason` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `connector_sync_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `connector_sync_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `connector_quarantined_records_run_idx` ON `connector_quarantined_records` (`run_id`);--> statement-breakpoint
CREATE INDEX `connector_quarantined_records_owner_idx` ON `connector_quarantined_records` (`owner_id`,`created_at`);--> statement-breakpoint
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
	`allowed_actions` text DEFAULT '[]' NOT NULL,
	`dataset` text NOT NULL,
	`resource_type` text DEFAULT 'generic' NOT NULL,
	`connection_name` text,
	`input` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`prompt` text,
	`prompt_version` integer DEFAULT 1 NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`checkpoint` text,
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
	`agent_model` text,
	`prompt_version` integer DEFAULT 1 NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `connector_sync_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `connector_sync_runs_job_started_idx` ON `connector_sync_runs` (`job_id`,`started_at`);