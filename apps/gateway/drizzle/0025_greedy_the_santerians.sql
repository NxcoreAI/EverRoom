CREATE TABLE `agent_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`prompt` text NOT NULL,
	`schedule_type` text DEFAULT 'daily' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`local_time` text DEFAULT '09:00' NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_status` text,
	`last_error` text,
	`config_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_schedules_due_idx` ON `agent_schedules` (`enabled`,`next_run_at`);
