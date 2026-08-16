CREATE TABLE `parsed_contents` (
	`id` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`parser_version` text NOT NULL,
	`markdown` text NOT NULL,
	`parsed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parsed_contents_hash_parser_idx` ON `parsed_contents` (`content_hash`,`parser_version`);--> statement-breakpoint
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
