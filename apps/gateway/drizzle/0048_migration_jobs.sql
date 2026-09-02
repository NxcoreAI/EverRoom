CREATE TABLE IF NOT EXISTS `migration_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`source_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL DEFAULT '{}',
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`run_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `migration_jobs_status_run_at_idx` ON `migration_jobs` (`status`,`run_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `migration_jobs_run_idx` ON `migration_jobs` (`run_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `migration_jobs_source_idx` ON `migration_jobs` (`source_id`);
