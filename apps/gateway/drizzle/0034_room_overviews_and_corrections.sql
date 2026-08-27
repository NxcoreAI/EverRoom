CREATE TABLE IF NOT EXISTS `room_overviews` (
	`room_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`base_projection` text NOT NULL,
	`projection` text NOT NULL,
	`generated_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `context_rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `room_overviews_updated_idx` ON `room_overviews` (`updated_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `room_context_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`operation` text NOT NULL,
	`section` text NOT NULL,
	`target_claim_id` text,
	`target_source` text,
	`target_room_id` text,
	`original_text` text,
	`replacement_text` text,
	`rationale` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`entry_point` text NOT NULL,
	`session_id` text,
	`proposed_by_run_id` text,
	`applied_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `context_rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `room_context_corrections_room_status_idx` ON `room_context_corrections` (`room_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `room_context_corrections_session_idx` ON `room_context_corrections` (`session_id`);
