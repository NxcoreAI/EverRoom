CREATE TABLE `room_local_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`status` text,
	`priority` text,
	`due_at` integer,
	`started_at` integer,
	`end_at` integer,
	`all_day` integer,
	`location` text,
	`completed_at` integer,
	`created_by` text NOT NULL,
	`created_via_run_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`room_id`) REFERENCES `context_rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `room_local_actions_room_idx` ON `room_local_actions` (`room_id`,`kind`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `room_local_actions_room_due_idx` ON `room_local_actions` (`room_id`,`kind`,`due_at`,`started_at`);