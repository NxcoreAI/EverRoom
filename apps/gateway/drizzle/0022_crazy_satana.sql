CREATE TABLE `file_blobs` (
	`content_hash` text PRIMARY KEY NOT NULL,
	`storage_path` text NOT NULL,
	`byte_size` integer NOT NULL,
	`mime` text DEFAULT 'application/octet-stream' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_blobs_storage_path_unique` ON `file_blobs` (`storage_path`);
--> statement-breakpoint
CREATE TABLE `file_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`source_kind` text NOT NULL,
	`source_key` text NOT NULL,
	`original_name` text NOT NULL,
	`display_name` text,
	`extension` text NOT NULL,
	`provider` text,
	`connection_id` text,
	`local_source_id` text,
	`local_item_id` text,
	`relative_path` text,
	`source_uri` text,
	`current_version_id` text,
	`state` text DEFAULT 'processing' NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_entries_source_key_idx` ON `file_entries` (`source_kind`,`source_key`);
--> statement-breakpoint
CREATE INDEX `file_entries_state_updated_idx` ON `file_entries` (`state`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `file_entries_local_item_idx` ON `file_entries` (`local_source_id`,`local_item_id`);
--> statement-breakpoint
CREATE TABLE `file_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`file_entry_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`content_hash` text NOT NULL,
	`source_modified_at` integer,
	`parser_id` text NOT NULL,
	`parser_version` integer NOT NULL,
	`parsed_id` text,
	`ingest_event_id` text,
	`status` text DEFAULT 'stored' NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`file_entry_id`) REFERENCES `file_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`content_hash`) REFERENCES `file_blobs`(`content_hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parsed_id`) REFERENCES `parsed_contents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_versions_entry_version_idx` ON `file_versions` (`file_entry_id`,`version_no`);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_versions_entry_hash_idx` ON `file_versions` (`file_entry_id`,`content_hash`);
--> statement-breakpoint
CREATE INDEX `file_versions_hash_idx` ON `file_versions` (`content_hash`);
--> statement-breakpoint
CREATE INDEX `file_versions_status_created_idx` ON `file_versions` (`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `file_classifications` (
	`id` text PRIMARY KEY NOT NULL,
	`file_version_id` text NOT NULL,
	`category` text NOT NULL,
	`summary` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`embedding` text,
	`confidence` real NOT NULL,
	`model` text NOT NULL,
	`prompt_version` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`file_version_id`) REFERENCES `file_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_classifications_version_idx` ON `file_classifications` (`file_version_id`);
--> statement-breakpoint
CREATE TABLE `file_clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_title` text NOT NULL,
	`title_source` text NOT NULL,
	`title_pinned` integer DEFAULT false NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`embedding` text,
	`embedding_model` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `file_cluster_memberships` (
	`file_entry_id` text PRIMARY KEY NOT NULL,
	`cluster_id` text NOT NULL,
	`confidence` real NOT NULL,
	`decided_by` text NOT NULL,
	`model` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_entry_id`) REFERENCES `file_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cluster_id`) REFERENCES `file_clusters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `file_cluster_memberships_cluster_idx` ON `file_cluster_memberships` (`cluster_id`);
