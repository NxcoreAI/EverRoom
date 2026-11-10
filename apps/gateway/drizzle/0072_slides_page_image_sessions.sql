CREATE TABLE `slides_page_image_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`draft_document_id` text NOT NULL,
	`style_session_id` text,
	`stage` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`plan` text NOT NULL,
	`pages` text NOT NULL,
	`style_palette` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `slides_page_image_sessions_draft_idx` ON `slides_page_image_sessions` (`room_id`,`draft_document_id`);
