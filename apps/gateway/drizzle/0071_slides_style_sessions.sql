CREATE TABLE `slides_style_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`draft_document_id` text,
	`instruction` text DEFAULT '' NOT NULL,
	`feedback` text NOT NULL,
	`overview_images` text NOT NULL,
	`selected_image_hash` text,
	`style_params` text,
	`demo_image_hash` text,
	`stage` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `slides_style_sessions_room_idx` ON `slides_style_sessions` (`room_id`,`stage`);
