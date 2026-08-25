CREATE TABLE `clipper_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`capture_id` text NOT NULL,
	`file_version_id` text NOT NULL,
	`content_hash` text,
	`original_url` text NOT NULL,
	`mime` text,
	`byte_size` integer,
	`alt_text` text,
	`width` integer,
	`height` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`capture_id`) REFERENCES `clipper_captures`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_version_id`) REFERENCES `file_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`content_hash`) REFERENCES `file_blobs`(`content_hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `clipper_assets_capture_idx` ON `clipper_assets` (`capture_id`,`status`);--> statement-breakpoint
CREATE INDEX `clipper_assets_hash_idx` ON `clipper_assets` (`content_hash`);--> statement-breakpoint
CREATE TABLE `clipper_captures` (
	`id` text PRIMARY KEY NOT NULL,
	`capture_key` text NOT NULL,
	`file_entry_id` text,
	`file_version_id` text,
	`source_url` text NOT NULL,
	`canonical_url` text NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`published_at` text,
	`captured_at` integer NOT NULL,
	`extraction_mode` text NOT NULL,
	`raw_content_hash` text NOT NULL,
	`extractor_version` text NOT NULL,
	`parser_version` text NOT NULL,
	`status` text DEFAULT 'storing' NOT NULL,
	`asset_count` integer DEFAULT 0 NOT NULL,
	`stored_asset_count` integer DEFAULT 0 NOT NULL,
	`failed_asset_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_entry_id`) REFERENCES `file_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_version_id`) REFERENCES `file_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clipper_captures_capture_key_unique` ON `clipper_captures` (`capture_key`);--> statement-breakpoint
CREATE INDEX `clipper_captures_file_entry_idx` ON `clipper_captures` (`file_entry_id`,`captured_at`);--> statement-breakpoint
CREATE INDEX `clipper_captures_canonical_idx` ON `clipper_captures` (`canonical_url`,`captured_at`);--> statement-breakpoint
CREATE INDEX `clipper_captures_status_idx` ON `clipper_captures` (`status`,`updated_at`);