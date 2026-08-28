CREATE TABLE IF NOT EXISTS `external_document_bindings` (
	`document_id` text PRIMARY KEY NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`room_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`source_hash` text NOT NULL,
	`projected_markdown` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `external_document_bindings_source_idx` ON `external_document_bindings` (`source_kind`,`source_id`,`resource_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `external_document_patch_preparations` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`command_id` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`command` text NOT NULL,
	`expected_source_hash` text NOT NULL,
	`patch` text NOT NULL,
	`prepared_markdown` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`resulting_source_hash` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`operation_id`) REFERENCES `document_operations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `external_document_patch_command_idx` ON `external_document_patch_preparations` (`operation_id`,`command_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `external_document_patch_expiry_idx` ON `external_document_patch_preparations` (`status`,`expires_at`);
