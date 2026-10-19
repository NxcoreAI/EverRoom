CREATE TABLE `search_index` (
	`id` text PRIMARY KEY NOT NULL,
	`item_type` text NOT NULL,
	`ref_id` text NOT NULL,
	`title` text NOT NULL,
	`body_preview` text DEFAULT '' NOT NULL,
	`source_kind` text,
	`occurred_at` integer,
	`ingested_at` integer NOT NULL,
	`time_basis` text DEFAULT 'ingested' NOT NULL,
	`file_version_id` text,
	`version_label` text,
	`session_id` text,
	`status` text DEFAULT 'meta_only' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_index_item_ref_idx` ON `search_index` (`item_type`,`ref_id`);
--> statement-breakpoint
CREATE INDEX `search_index_status_idx` ON `search_index` (`status`);
--> statement-breakpoint
CREATE INDEX `search_index_item_type_idx` ON `search_index` (`item_type`);
--> statement-breakpoint
CREATE TABLE `search_index_rooms` (
	`index_id` text NOT NULL,
	`room_id` text NOT NULL,
	PRIMARY KEY (`index_id`,`room_id`)
);
--> statement-breakpoint
CREATE INDEX `search_index_rooms_room_idx` ON `search_index_rooms` (`room_id`);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `search_index_fts` USING fts5(`tokens`, tokenize='unicode61');
