CREATE TABLE `agent_session_participants` (
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`runtime_session_ref` text,
	`last_seen_at` integer,
	`workspace_root` text,
	`permission_profile` text DEFAULT 'inspect' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `agent_id`),
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_session_participants_agent_idx` ON `agent_session_participants` (`agent_id`);--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `author_agent_id` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `agent_id` text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `invocation_mode` text DEFAULT 'explicit_switch' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `active_agent_id` text DEFAULT 'main' NOT NULL;--> statement-breakpoint
INSERT INTO `agent_session_participants` (`session_id`, `agent_id`, `runtime_id`, `runtime_session_ref`, `permission_profile`, `created_at`, `updated_at`)
SELECT `id`, 'main', `runtime_id`, `runtime_session_ref`, 'inspect', `created_at`, `updated_at` FROM `agent_sessions`;
