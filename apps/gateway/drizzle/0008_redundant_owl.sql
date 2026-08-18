CREATE TABLE `document_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`parent_block_id` text,
	`type` text NOT NULL,
	`ordinal` integer NOT NULL,
	`path` text NOT NULL,
	`text_preview` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_blocks_document_ordinal_idx` ON `document_blocks` (`document_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `document_blocks_document_idx` ON `document_blocks` (`document_id`);--> statement-breakpoint
CREATE TABLE `document_patch_hunks` (
	`id` text PRIMARY KEY NOT NULL,
	`patch_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`operation` text NOT NULL,
	`target` text NOT NULL,
	`markdown` text NOT NULL,
	`sha256` text NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`added_characters` integer DEFAULT 0 NOT NULL,
	`deleted_characters` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`patch_id`) REFERENCES `document_patches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_patch_hunks_patch_sequence_idx` ON `document_patch_hunks` (`patch_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `document_patches` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`document_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'building' NOT NULL,
	`summary` text NOT NULL,
	`base_version` integer NOT NULL,
	`base_content_json` text NOT NULL,
	`proposed_content_json` text NOT NULL,
	`next_sequence` integer DEFAULT 1 NOT NULL,
	`accepted_hunk_ids` text,
	`rejected_hunk_ids` text,
	`applied_version` integer,
	`conflict_version` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `document_patches_document_status_idx` ON `document_patches` (`document_id`,`status`);--> statement-breakpoint
CREATE INDEX `document_patches_session_status_idx` ON `document_patches` (`agent_session_id`,`status`);--> statement-breakpoint
CREATE INDEX `document_patches_expiry_idx` ON `document_patches` (`status`,`expires_at`);--> statement-breakpoint
ALTER TABLE `doc_versions` ADD `source_patch_id` text;