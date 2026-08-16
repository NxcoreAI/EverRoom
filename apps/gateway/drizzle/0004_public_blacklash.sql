CREATE TABLE `room_wikis` (
	`room_id` text PRIMARY KEY NOT NULL,
	`knowledge_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`centroid` text,
	`centroid_docs` integer DEFAULT 0 NOT NULL,
	`centroid_model` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`kind` text DEFAULT '议题' NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`summary` text,
	`aliases` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `route_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_kind` text DEFAULT 'everroom-doc' NOT NULL,
	`source_id` text NOT NULL,
	`source_version` integer NOT NULL,
	`primary_room_id` text,
	`linked_room_ids` text,
	`new_room_name` text,
	`new_room_summary` text,
	`confidence` real NOT NULL,
	`decided_by` text NOT NULL,
	`evidence` text,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `route_decisions_source_idx` ON `route_decisions` (`source_kind`,`source_id`);--> statement-breakpoint
CREATE TABLE `routing_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`matcher` text NOT NULL,
	`target_room_id` text NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_hit_at` integer
);
