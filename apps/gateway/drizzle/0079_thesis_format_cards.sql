CREATE TABLE `thesis_format_cards` (
	`room_id` text PRIMARY KEY NOT NULL,
	`format_card` text NOT NULL,
	`source_file_entry_id` text,
	`source_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
