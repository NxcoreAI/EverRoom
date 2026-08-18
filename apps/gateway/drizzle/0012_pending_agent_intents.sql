CREATE TABLE `pending_agent_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`source_run_id` text NOT NULL,
	`original_prompt` text NOT NULL,
	`target_capability` text NOT NULL,
	`allowed_room_ids` text NOT NULL,
	`allowed_document_ids` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pending_agent_intents_session_idx` ON `pending_agent_intents` (`session_id`);--> statement-breakpoint
CREATE INDEX `pending_agent_intents_source_run_idx` ON `pending_agent_intents` (`source_run_id`);--> statement-breakpoint
CREATE INDEX `pending_agent_intents_expires_idx` ON `pending_agent_intents` (`expires_at`);