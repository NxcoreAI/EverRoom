CREATE TABLE `context_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`kind` text,
	`data` text NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_rooms_deleted_idx` ON `context_rooms` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `context_rooms_updated_idx` ON `context_rooms` (`updated_at`);--> statement-breakpoint
UPDATE `agent_sessions` SET `room_id` = NULL WHERE `room_id` = '';
