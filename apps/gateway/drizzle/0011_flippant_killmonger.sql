CREATE TABLE `document_operation_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`operation_id`) REFERENCES `document_operations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_operation_commands_operation_id_idx` ON `document_operation_commands` (`operation_id`,`id`);--> statement-breakpoint
CREATE TABLE `document_operation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`revision` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `document_operations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_operation_events_revision_idx` ON `document_operation_events` (`operation_id`,`revision`);--> statement-breakpoint
CREATE INDEX `document_operation_events_created_idx` ON `document_operation_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `document_operation_items` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`operation` text NOT NULL,
	`target` text,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`markdown` text DEFAULT '' NOT NULL,
	`content_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`applied_version` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `document_operations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_operation_items_sequence_idx` ON `document_operation_items` (`operation_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `document_operation_items_status_idx` ON `document_operation_items` (`operation_id`,`status`);--> statement-breakpoint
CREATE TABLE `document_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`capability_id` text NOT NULL,
	`capability_version` integer NOT NULL,
	`interaction_mode` text NOT NULL,
	`presenter_key` text NOT NULL,
	`room_id` text NOT NULL,
	`document_id` text,
	`document_title` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`base_version` integer,
	`status` text DEFAULT 'created' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`summary` text NOT NULL,
	`input` text NOT NULL,
	`result` text,
	`conflict_version` integer,
	`error` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `document_operations_document_status_idx` ON `document_operations` (`document_id`,`status`);--> statement-breakpoint
CREATE INDEX `document_operations_room_status_idx` ON `document_operations` (`room_id`,`status`);--> statement-breakpoint
CREATE INDEX `document_operations_session_status_idx` ON `document_operations` (`agent_session_id`,`status`);--> statement-breakpoint
CREATE INDEX `document_operations_expiry_idx` ON `document_operations` (`status`,`expires_at`);--> statement-breakpoint
ALTER TABLE `doc_versions` ADD `title` text DEFAULT '无标题文档' NOT NULL;--> statement-breakpoint
UPDATE `doc_versions`
SET `title` = COALESCE(
	(SELECT `documents`.`title` FROM `documents` WHERE `documents`.`id` = `doc_versions`.`document_id`),
	`doc_versions`.`title`
);
