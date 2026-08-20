ALTER TABLE `diary_version_sources` ADD `ended_at` integer;--> statement-breakpoint
ALTER TABLE `diary_version_sources` ADD `time_basis` text DEFAULT 'recorded_at' NOT NULL;