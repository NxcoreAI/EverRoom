CREATE TABLE `slides_storyboards` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`draft_document_id` text NOT NULL,
	`draft_hash` text NOT NULL,
	`storyboard` text NOT NULL,
	`report` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `slides_storyboards_draft_idx` ON `slides_storyboards` (`room_id`,`draft_document_id`);
