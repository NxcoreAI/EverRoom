CREATE TABLE `document_yjs_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`through_version` integer NOT NULL,
	`doc_state` blob NOT NULL,
	`state_vector` blob NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_yjs_checkpoints_document_version_idx` ON `document_yjs_checkpoints` (`document_id`,`through_version`);--> statement-breakpoint
CREATE INDEX `document_yjs_checkpoints_document_idx` ON `document_yjs_checkpoints` (`document_id`);--> statement-breakpoint
CREATE TABLE `document_yjs_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`update` blob NOT NULL,
	`source` text DEFAULT 'commit' NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_yjs_updates_document_version_idx` ON `document_yjs_updates` (`document_id`,`version`);--> statement-breakpoint
CREATE INDEX `document_yjs_updates_document_idx` ON `document_yjs_updates` (`document_id`,`version`);--> statement-breakpoint
CREATE TABLE `document_yjs_versions` (
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`update_id` text NOT NULL,
	`checkpoint_id` text,
	`state_vector` blob NOT NULL,
	`backfilled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`document_id`, `version`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`update_id`) REFERENCES `document_yjs_updates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `document_yjs_checkpoints`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `document_yjs_versions_update_idx` ON `document_yjs_versions` (`update_id`);