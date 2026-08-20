CREATE TABLE `subagent_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`current_revision_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subagent_invocation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`invocation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invocation_id`) REFERENCES `subagent_invocations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subagent_invocation_events_invocation_seq_idx` ON `subagent_invocation_events` (`invocation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `subagent_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_definition_id` text NOT NULL,
	`agent_revision_id` text NOT NULL,
	`source` text NOT NULL,
	`parent_session_id` text,
	`parent_run_id` text,
	`idempotency_key` text NOT NULL,
	`task` text NOT NULL,
	`input` text NOT NULL,
	`status` text DEFAULT 'accepted' NOT NULL,
	`runtime_session_ref` text,
	`last_event_seq` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error_code` text,
	`error_message` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_definition_id`) REFERENCES `subagent_definitions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agent_revision_id`) REFERENCES `subagent_revisions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subagent_invocations_source_idempotency_idx` ON `subagent_invocations` (`source`,`parent_run_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `subagent_invocations_status_created_idx` ON `subagent_invocations` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `subagent_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_definition_id` text NOT NULL,
	`version` integer NOT NULL,
	`digest` text NOT NULL,
	`manifest` text NOT NULL,
	`system_prompt` text NOT NULL,
	`agent_directory` text NOT NULL,
	`mcp_servers` text NOT NULL,
	`policy` text NOT NULL,
	`input_schema` text,
	`output_schema` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_definition_id`) REFERENCES `subagent_definitions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subagent_revisions_definition_version_idx` ON `subagent_revisions` (`agent_definition_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `subagent_revisions_definition_digest_idx` ON `subagent_revisions` (`agent_definition_id`,`digest`);