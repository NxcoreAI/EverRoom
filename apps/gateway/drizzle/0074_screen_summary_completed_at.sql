ALTER TABLE `screen_intervals` ADD `summary_completed_at` integer;
--> statement-breakpoint
CREATE INDEX `screen_intervals_summary_completed_idx` ON `screen_intervals` (`summary_completed_at`);
