CREATE TABLE `room_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`kind` text DEFAULT 'task' NOT NULL,
	`title` text NOT NULL,
	`data` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `room_folders_room_idx` ON `room_folders` (`room_id`,`deleted_at`);
--> statement-breakpoint
ALTER TABLE `room_doc_links` ADD `folder_id` text;
--> statement-breakpoint
CREATE INDEX `room_doc_links_folder_idx` ON `room_doc_links` (`folder_id`);
--> statement-breakpoint
ALTER TABLE `room_source_memberships` ADD `folder_id` text;
