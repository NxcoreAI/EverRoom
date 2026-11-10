CREATE TABLE `agent_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tool` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`scopes` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen_at` integer,
	`example_query_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_connections_token_hash_idx` ON `agent_connections` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `agent_connections_status_idx` ON `agent_connections` (`status`);
--> statement-breakpoint
CREATE TABLE `agent_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`client_submission_id` text NOT NULL,
	`items` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`results` text,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`connection_id`) REFERENCES `agent_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_submissions_connection_client_idx` ON `agent_submissions` (`connection_id`,`client_submission_id`);
--> statement-breakpoint
CREATE INDEX `agent_submissions_recent_idx` ON `agent_submissions` (`connection_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `agent_access_events` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`kind` text NOT NULL,
	`tool` text,
	`status` text NOT NULL,
	`duration_ms` integer,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `agent_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_access_events_recent_idx` ON `agent_access_events` (`connection_id`,`created_at`);
