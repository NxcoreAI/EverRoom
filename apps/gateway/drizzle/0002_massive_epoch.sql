CREATE TABLE `doc_ops` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`markdown` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_length` integer NOT NULL,
	`applied_content_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `doc_transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `doc_ops_transaction_sequence_idx` ON `doc_ops` (`transaction_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `doc_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`room_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`next_sequence` integer DEFAULT 1 NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`working_content_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`agent_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `doc_transactions_session_idx` ON `doc_transactions` (`agent_session_id`);--> statement-breakpoint
CREATE INDEX `doc_transactions_expiry_idx` ON `doc_transactions` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `doc_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`content_json` text NOT NULL,
	`source_transaction_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `doc_versions_document_version_idx` ON `doc_versions` (`document_id`,`version`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`content_json` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`active_transaction_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `room_doc_links` (
	`room_id` text NOT NULL,
	`document_id` text NOT NULL,
	`linked_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_doc_links_room_document_idx` ON `room_doc_links` (`room_id`,`document_id`);--> statement-breakpoint
CREATE INDEX `room_doc_links_room_idx` ON `room_doc_links` (`room_id`);