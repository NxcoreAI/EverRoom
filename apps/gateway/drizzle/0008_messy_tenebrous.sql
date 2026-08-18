CREATE TABLE `ingest_events` (
	`id` text PRIMARY KEY NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_version` integer NOT NULL,
	`data_type` text NOT NULL,
	`detected_by` text NOT NULL,
	`title` text NOT NULL,
	`content_hash` text NOT NULL,
	`parsed_id` text NOT NULL,
	`pipelines` text NOT NULL,
	`memory_result` text,
	`route_job_id` text,
	`origin_channel` text DEFAULT 'upload' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ingest_events_source_idx` ON `ingest_events` (`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `ingest_events_source_hash_idx` ON `ingest_events` (`source_id`,`content_hash`);
