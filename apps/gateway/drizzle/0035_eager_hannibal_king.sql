CREATE TABLE IF NOT EXISTS `connector_todos` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`service` text NOT NULL,
	`connection_name` text,
	`source_record_id` text NOT NULL,
	`source_updated_at` integer,
	`synced_at` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`prompt_version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`extension_payload` text,
	`deleted_at` integer,
	`todo_id` text NOT NULL,
	`title` text NOT NULL,
	`notes` text NOT NULL,
	`status` text,
	`due_at` integer,
	`completed_at` integer,
	`priority` text,
	`list_id` text,
	`list_name` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `connector_todos_owner_source_idx` ON `connector_todos` (`owner_id`,`service`,`connection_name`,`source_record_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `connector_todos_owner_due_idx` ON `connector_todos` (`owner_id`,`due_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `connector_todos_owner_todo_idx` ON `connector_todos` (`owner_id`,`todo_id`);
