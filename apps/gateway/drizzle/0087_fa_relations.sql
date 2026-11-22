CREATE TABLE `fa_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`subject_entity_id` text NOT NULL,
	`object_entity_id` text NOT NULL,
	`subject_room_id` text,
	`object_room_id` text,
	`title` text,
	`from_year` integer,
	`to_year` integer,
	`round` text,
	`role` text,
	`source_kind` text,
	`source_id` text,
	`evidence` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`confirmed_by` text,
	`confirmed_at` integer,
	`room_relation_id` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `fa_relations_subject_idx` ON `fa_relations` (`subject_entity_id`);
--> statement-breakpoint
CREATE INDEX `fa_relations_object_idx` ON `fa_relations` (`object_entity_id`);
--> statement-breakpoint
CREATE INDEX `fa_relations_status_idx` ON `fa_relations` (`status`);
--> statement-breakpoint
CREATE INDEX `fa_relations_subject_room_idx` ON `fa_relations` (`subject_room_id`);
--> statement-breakpoint
CREATE INDEX `fa_relations_object_room_idx` ON `fa_relations` (`object_room_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `fa_relations_triple_idx` ON `fa_relations` (`type`,`subject_entity_id`,`object_entity_id`);
