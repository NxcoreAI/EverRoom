CREATE TABLE `screen_intervals` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`app_name` text NOT NULL,
	`window_title` text,
	`title` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`end_reason` text NOT NULL,
	`keyframe_count` integer DEFAULT 0 NOT NULL,
	`text_lines` text NOT NULL,
	`summary_status` text DEFAULT 'pending' NOT NULL,
	`summary` text,
	`summary_key_points` text NOT NULL,
	`user_edited` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `screen_intervals_range_idx` ON `screen_intervals` (`started_at`,`ended_at`);
--> statement-breakpoint
CREATE INDEX `screen_intervals_app_idx` ON `screen_intervals` (`bundle_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `screen_intervals_summary_idx` ON `screen_intervals` (`summary_status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `screen_keyframes` (
	`id` text PRIMARY KEY NOT NULL,
	`interval_id` text NOT NULL,
	`captured_at` integer NOT NULL,
	`image_path` text NOT NULL,
	`image_bytes` integer DEFAULT 0 NOT NULL,
	`perceptual_hash` text,
	`width` integer,
	`height` integer,
	`line_count` integer DEFAULT 0 NOT NULL,
	`elapsed_ms` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`interval_id`) REFERENCES `screen_intervals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `screen_keyframes_interval_idx` ON `screen_keyframes` (`interval_id`,`captured_at`);
