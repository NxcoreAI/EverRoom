CREATE TABLE IF NOT EXISTS `doc_ops` (
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
CREATE UNIQUE INDEX IF NOT EXISTS `doc_ops_transaction_sequence_idx` ON `doc_ops` (`transaction_id`,`sequence`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `doc_transactions` (
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
CREATE INDEX IF NOT EXISTS `doc_transactions_session_idx` ON `doc_transactions` (`agent_session_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `doc_transactions_expiry_idx` ON `doc_transactions` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `doc_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`content_json` text NOT NULL,
	`source_transaction_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `doc_versions_document_version_idx` ON `doc_versions` (`document_id`,`version`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `documents` (
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
CREATE TABLE IF NOT EXISTS `room_doc_links` (
	`room_id` text NOT NULL,
	`document_id` text NOT NULL,
	`linked_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `room_doc_links_room_document_idx` ON `room_doc_links` (`room_id`,`document_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `room_doc_links_room_idx` ON `room_doc_links` (`room_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `reality_events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`processing_state` text NOT NULL,
	`capture_device` text NOT NULL,
	`processing_device` text NOT NULL,
	`audio_source` text NOT NULL,
	`audio_file_name` text,
	`audio_mime_type` text,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`current_topic` text,
	`transcript` text DEFAULT '' NOT NULL,
	`transcript_segments` text NOT NULL,
	`transcript_edited_at` integer,
	`insights` text NOT NULL,
	`markers` text NOT NULL,
	`important` integer DEFAULT false NOT NULL,
	`asr_job_id` text,
	`asr_source` text,
	`result_version` integer DEFAULT 0 NOT NULL,
	`error` text,
	`version` integer DEFAULT 1 NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `reality_events_asr_job_idx` ON `reality_events` (`asr_job_id`);
