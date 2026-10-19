ALTER TABLE `thesis_format_cards` RENAME TO `thesis_format_cards_old`;
--> statement-breakpoint
CREATE TABLE `thesis_format_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`format_card` text NOT NULL,
	`source_file_entry_id` text,
	`source_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thesis_format_cards_room_source_idx` ON `thesis_format_cards` (`room_id`,`source_name`);
--> statement-breakpoint
INSERT INTO `thesis_format_cards` (`id`,`room_id`,`format_card`,`source_file_entry_id`,`source_name`,`created_at`,`updated_at`)
	SELECT lower(hex(randomblob(16))), `room_id`, `format_card`, `source_file_entry_id`, `source_name`, `created_at`, `updated_at` FROM `thesis_format_cards_old`;
--> statement-breakpoint
DROP TABLE `thesis_format_cards_old`;
