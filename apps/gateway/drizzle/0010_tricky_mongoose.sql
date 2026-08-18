CREATE TABLE `document_block_references` (
	`source_document_id` text NOT NULL,
	`source_block_id` text NOT NULL,
	`target_room_id` text NOT NULL,
	`target_document_id` text NOT NULL,
	`target_block_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`indexed_version` integer NOT NULL,
	PRIMARY KEY(`source_document_id`, `ordinal`),
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `document_block_references_source_idx` ON `document_block_references` (`source_document_id`,`source_block_id`);--> statement-breakpoint
CREATE INDEX `document_block_references_target_idx` ON `document_block_references` (`target_document_id`,`target_block_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_document_blocks` (
	`document_id` text NOT NULL,
	`block_id` text NOT NULL,
	`parent_block_id` text,
	`root_block_id` text NOT NULL,
	`type` text NOT NULL,
	`sibling_index` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`path` text NOT NULL,
	`depth` integer NOT NULL,
	`text_preview` text NOT NULL,
	`indexed_version` integer NOT NULL,
	PRIMARY KEY(`document_id`, `block_id`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP TABLE `document_blocks`;--> statement-breakpoint
ALTER TABLE `__new_document_blocks` RENAME TO `document_blocks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `document_blocks_document_ordinal_idx` ON `document_blocks` (`document_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `document_blocks_document_idx` ON `document_blocks` (`document_id`);--> statement-breakpoint
CREATE INDEX `document_blocks_root_idx` ON `document_blocks` (`document_id`,`root_block_id`);--> statement-breakpoint
ALTER TABLE `doc_versions` ADD `content_schema_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `content_schema_version` integer DEFAULT 1 NOT NULL;
