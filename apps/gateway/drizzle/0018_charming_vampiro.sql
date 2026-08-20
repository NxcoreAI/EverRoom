CREATE TABLE `connector_markdown_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`service` text NOT NULL,
	`connection_name` text NOT NULL,
	`resource_type` text NOT NULL,
	`source_record_id` text NOT NULL,
	`ingest_source_id` text NOT NULL,
	`active_path` text NOT NULL,
	`source_content_hash` text NOT NULL,
	`markdown_content_hash` text,
	`renderer_version` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`ingest_status` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`parsed_id` text,
	`ingest_event_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_markdown_artifacts_source_idx` ON `connector_markdown_artifacts` (`owner_id`,`service`,`connection_name`,`resource_type`,`source_record_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `connector_markdown_artifacts_ingest_source_idx` ON `connector_markdown_artifacts` (`resource_type`,`ingest_source_id`);--> statement-breakpoint
CREATE INDEX `connector_markdown_artifacts_status_idx` ON `connector_markdown_artifacts` (`status`,`ingest_status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `connector_markdown_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`ingest_source_id` text NOT NULL,
	`operation` text NOT NULL,
	`source_content_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`lease_owner` text,
	`lease_until` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connector_markdown_outbox_due_idx` ON `connector_markdown_outbox` (`status`,`available_at`,`lease_until`);--> statement-breakpoint
CREATE INDEX `connector_markdown_outbox_source_idx` ON `connector_markdown_outbox` (`resource_type`,`ingest_source_id`,`created_at`);--> statement-breakpoint
DROP INDEX `ingest_events_source_hash_idx`;--> statement-breakpoint
CREATE INDEX `ingest_events_source_hash_idx` ON `ingest_events` (`source_kind`,`source_id`,`content_hash`);
