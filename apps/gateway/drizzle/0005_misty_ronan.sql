PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_route_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_kind` text DEFAULT 'everroom-doc' NOT NULL,
	`source_id` text NOT NULL,
	`source_version` integer NOT NULL,
	`source_title` text,
	`source_markdown` text,
	`primary_room_id` text,
	`linked_room_ids` text,
	`new_room_name` text,
	`new_room_summary` text,
	`new_room_kind` text,
	`confidence` real NOT NULL,
	`decided_by` text,
	`evidence` text,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_route_decisions`("id", "source_kind", "source_id", "source_version", "source_title", "source_markdown", "primary_room_id", "linked_room_ids", "new_room_name", "new_room_summary", "new_room_kind", "confidence", "decided_by", "evidence", "reason", "status", "created_at", "updated_at") SELECT "id", "source_kind", "source_id", "source_version", NULL, NULL, "primary_room_id", "linked_room_ids", "new_room_name", "new_room_summary", NULL, "confidence", "decided_by", "evidence", "reason", "status", "created_at", "updated_at" FROM `route_decisions`;--> statement-breakpoint
DROP TABLE `route_decisions`;--> statement-breakpoint
ALTER TABLE `__new_route_decisions` RENAME TO `route_decisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `route_decisions_source_idx` ON `route_decisions` (`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `route_decisions_status_idx` ON `route_decisions` (`status`);