CREATE TABLE `agent_session_links` (
	`id` text PRIMARY KEY NOT NULL,
	`source_session_id` text NOT NULL,
	`target_session_id` text NOT NULL,
	`source_run_id` text NOT NULL,
	`source_page_id` text NOT NULL,
	`source_page_label` text NOT NULL,
	`source_room_id` text,
	`target_key` text NOT NULL,
	`target` text NOT NULL,
	`returned_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_links_source_target_idx` ON `agent_session_links` (`source_run_id`,`target_key`);--> statement-breakpoint
CREATE INDEX `agent_session_links_source_session_idx` ON `agent_session_links` (`source_session_id`);--> statement-breakpoint
CREATE INDEX `agent_session_links_target_session_idx` ON `agent_session_links` (`target_session_id`);