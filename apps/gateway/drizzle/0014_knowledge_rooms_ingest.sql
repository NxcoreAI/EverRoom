CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`aliases` text,
	`kind` text DEFAULT '主题' NOT NULL,
	`summary` text,
	`status` text DEFAULT 'weak' NOT NULL,
	`room_id` text,
	`evidence_score` real DEFAULT 0 NOT NULL,
	`source_count` integer DEFAULT 0 NOT NULL,
	`centroid` text,
	`centroid_docs` integer DEFAULT 0 NOT NULL,
	`centroid_model` text,
	`merged_from` text,
	`last_linked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `entities_status_idx` ON `entities` (`status`);--> statement-breakpoint
CREATE INDEX `entities_name_idx` ON `entities` (`name`);--> statement-breakpoint
CREATE TABLE `entity_doc_links` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_version` integer NOT NULL,
	`role` text NOT NULL,
	`salience` real DEFAULT 0 NOT NULL,
	`evidence` text,
	`decided_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entity_doc_links_entity_source_idx` ON `entity_doc_links` (`entity_id`,`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `entity_doc_links_source_idx` ON `entity_doc_links` (`source_kind`,`source_id`);--> statement-breakpoint
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
CREATE INDEX `ingest_events_source_hash_idx` ON `ingest_events` (`source_id`,`content_hash`);--> statement-breakpoint
CREATE TABLE `parsed_contents` (
	`id` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`parser_version` text NOT NULL,
	`markdown` text NOT NULL,
	`parsed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parsed_contents_hash_parser_idx` ON `parsed_contents` (`content_hash`,`parser_version`);--> statement-breakpoint
CREATE TABLE `room_wikis` (
	`room_id` text PRIMARY KEY NOT NULL,
	`knowledge_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`centroid` text,
	`centroid_docs` integer DEFAULT 0 NOT NULL,
	`centroid_model` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`kind` text DEFAULT '议题' NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`summary` text,
	`aliases` text,
	`entity_id` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `route_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_kind` text DEFAULT 'everroom-doc' NOT NULL,
	`source_id` text NOT NULL,
	`source_version` integer NOT NULL,
	`source_title` text,
	`source_markdown` text,
	`primary_room_id` text,
	`linked_room_ids` text,
	`new_room_name` text,
	`new_room_summary` text,
	`new_room_kind` text,
	`confidence` real NOT NULL,
	`decided_by` text,
	`evidence` text,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `route_decisions_source_idx` ON `route_decisions` (`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `route_decisions_status_idx` ON `route_decisions` (`status`);--> statement-breakpoint
CREATE TABLE `routing_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`matcher` text NOT NULL,
	`target_room_id` text NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_hit_at` integer
);
--> statement-breakpoint
CREATE TABLE `uploaded_files` (
	`id` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`storage_path` text NOT NULL,
	`original_name` text NOT NULL,
	`bytes` integer NOT NULL,
	`mime` text DEFAULT 'text/markdown' NOT NULL,
	`current_parsed_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `doc_versions` DROP COLUMN `source_patch_id`;