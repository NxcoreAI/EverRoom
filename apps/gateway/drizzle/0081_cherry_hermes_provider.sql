ALTER TABLE `external_agent_threads` ADD `content_hash` text;
--> statement-breakpoint
ALTER TABLE `external_agent_threads` ADD `memory_rule_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `external_agent_messages` ADD `attachments` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
CREATE TABLE `migration_source_capabilities` (
	`source_id` text PRIMARY KEY NOT NULL,
	`import_state` text DEFAULT 'not_available' NOT NULL,
	`sync_state` text DEFAULT 'not_available' NOT NULL,
	`on_demand_state` text DEFAULT 'not_available' NOT NULL,
	`write_back_state` text DEFAULT 'not_available' NOT NULL,
	`native_restore_state` text DEFAULT 'not_available' NOT NULL,
	`sync_detail` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `data_migration_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
