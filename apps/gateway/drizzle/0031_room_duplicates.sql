CREATE TABLE `room_duplicate_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`room_a_id` text NOT NULL,
	`room_b_id` text NOT NULL,
	`name_score` real DEFAULT 0 NOT NULL,
	`centroid_score` real DEFAULT 0 NOT NULL,
	`content_overlap` real DEFAULT 0 NOT NULL,
	`entity_overlap` real DEFAULT 0 NOT NULL,
	`duplicate_score` real DEFAULT 0 NOT NULL,
	`confidence` text NOT NULL,
	`llm_verdict` text,
	`reasons` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`evidence_revision` text NOT NULL,
	`scoring_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_duplicate_candidates_pair_idx` ON `room_duplicate_candidates` (`room_a_id`,`room_b_id`);--> statement-breakpoint
CREATE INDEX `room_duplicate_candidates_status_idx` ON `room_duplicate_candidates` (`status`,`confidence`);--> statement-breakpoint
CREATE INDEX `room_duplicate_candidates_room_a_idx` ON `room_duplicate_candidates` (`room_a_id`);--> statement-breakpoint
CREATE INDEX `room_duplicate_candidates_room_b_idx` ON `room_duplicate_candidates` (`room_b_id`);--> statement-breakpoint
CREATE TABLE `room_memory_attributions` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`memory_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text,
	`confidence` text DEFAULT 'explicit' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_memory_attributions_memory_idx` ON `room_memory_attributions` (`memory_id`);--> statement-breakpoint
CREATE INDEX `room_memory_attributions_room_idx` ON `room_memory_attributions` (`room_id`);--> statement-breakpoint
CREATE TABLE `room_merge_items` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`before_room_id` text,
	`after_room_id` text,
	`before_value` text,
	`fingerprint` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `room_merge_operations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_merge_items_operation_resource_idx` ON `room_merge_items` (`operation_id`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `room_merge_items_operation_idx` ON `room_merge_items` (`operation_id`,`status`);--> statement-breakpoint
CREATE TABLE `room_merge_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`source_room_id` text NOT NULL,
	`target_room_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`preview_hash` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`commit_reached` integer DEFAULT false NOT NULL,
	`impact` text NOT NULL,
	`error` text,
	`confirmed_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_merge_operations_idempotency_idx` ON `room_merge_operations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `room_merge_operations_rooms_idx` ON `room_merge_operations` (`source_room_id`,`target_room_id`);--> statement-breakpoint
CREATE INDEX `room_merge_operations_status_idx` ON `room_merge_operations` (`status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `room_id` text;--> statement-breakpoint
ALTER TABLE `context_rooms` ADD `lifecycle` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `context_rooms` ADD `merged_into_room_id` text;--> statement-breakpoint
ALTER TABLE `context_rooms` ADD `merged_at` integer;--> statement-breakpoint
ALTER TABLE `rooms` ADD `lifecycle` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `merged_into_room_id` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `merged_at` integer;