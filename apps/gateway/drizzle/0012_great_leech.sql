PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_connector_sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`service` text NOT NULL,
	`action` text NOT NULL,
	`allowed_actions` text DEFAULT '[]' NOT NULL,
	`dataset` text NOT NULL,
	`resource_type` text DEFAULT 'generic' NOT NULL,
	`connection_name` text,
	`input` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`prompt` text,
	`prompt_version` integer DEFAULT 1 NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`checkpoint` text,
	`interval_ms` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_success_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_connector_sync_jobs`("id", "owner_id", "service", "action", "allowed_actions", "dataset", "resource_type", "connection_name", "input", "goal", "prompt", "prompt_version", "schema_version", "checkpoint", "interval_ms", "enabled", "next_run_at", "last_run_at", "last_success_at", "last_error", "created_at", "updated_at") SELECT "id", "owner_id", "service", "action", "allowed_actions", "dataset", "resource_type", "connection_name", "input", "goal", "prompt", "prompt_version", "schema_version", "checkpoint", "interval_ms", "enabled", "next_run_at", "last_run_at", "last_success_at", "last_error", "created_at", "updated_at" FROM `connector_sync_jobs`;--> statement-breakpoint
DROP TABLE `connector_sync_jobs`;--> statement-breakpoint
ALTER TABLE `__new_connector_sync_jobs` RENAME TO `connector_sync_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `connector_sync_jobs_due_idx` ON `connector_sync_jobs` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `connector_sync_jobs_owner_idx` ON `connector_sync_jobs` (`owner_id`);