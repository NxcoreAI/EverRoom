CREATE TABLE IF NOT EXISTS `data_migration_sources` (`id` text PRIMARY KEY NOT NULL, `provider` text NOT NULL, `transport` text NOT NULL, `stable_source_key` text NOT NULL, `display_name` text NOT NULL, `status` text DEFAULT 'ready' NOT NULL, `last_synced_at` integer, `error` text, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `data_migration_sources_stable_idx` ON `data_migration_sources` (`provider`,`stable_source_key`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `data_migration_runs` (`id` text PRIMARY KEY NOT NULL, `source_id` text NOT NULL, `provider` text NOT NULL, `transport` text NOT NULL, `status` text DEFAULT 'queued' NOT NULL, `phase` text DEFAULT 'discovering' NOT NULL, `pages_total` integer DEFAULT 0 NOT NULL, `pages_completed` integer DEFAULT 0 NOT NULL, `threads_total` integer DEFAULT 0 NOT NULL, `threads_completed` integer DEFAULT 0 NOT NULL, `messages_total` integer DEFAULT 0 NOT NULL, `messages_completed` integer DEFAULT 0 NOT NULL, `cancel_requested` integer DEFAULT false NOT NULL, `error` text, `started_at` integer NOT NULL, `completed_at` integer, FOREIGN KEY (`source_id`) REFERENCES `data_migration_sources`(`id`) ON UPDATE no action ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `data_migration_runs_source_started_idx` ON `data_migration_runs` (`source_id`,`started_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `external_agent_threads` (`id` text PRIMARY KEY NOT NULL, `source_id` text NOT NULL, `provider` text DEFAULT 'openclaw' NOT NULL, `stable_key` text NOT NULL, `agent_id` text, `external_session_id` text NOT NULL, `title` text NOT NULL, `import_version` integer DEFAULT 1 NOT NULL, `memory_session_id` text NOT NULL, `memory_status` text DEFAULT 'pending' NOT NULL, `available` integer DEFAULT true NOT NULL, `message_count` integer DEFAULT 0 NOT NULL, `started_at` integer, `last_message_at` integer, `last_message_excerpt` text DEFAULT '' NOT NULL, `last_seen_run_id` text, `created_at` integer NOT NULL, `updated_at` integer NOT NULL, FOREIGN KEY (`source_id`) REFERENCES `data_migration_sources`(`id`) ON UPDATE no action ON DELETE cascade);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `external_agent_threads_source_key_idx` ON `external_agent_threads` (`source_id`,`stable_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `external_agent_threads_recent_idx` ON `external_agent_threads` (`available`,`last_message_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `external_agent_messages` (`id` text PRIMARY KEY NOT NULL, `thread_id` text NOT NULL, `stable_key` text NOT NULL, `role` text NOT NULL, `content` text NOT NULL, `content_hash` text NOT NULL, `ordinal` integer NOT NULL, `occurred_at` integer NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL, FOREIGN KEY (`thread_id`) REFERENCES `external_agent_threads`(`id`) ON UPDATE no action ON DELETE cascade);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `external_agent_messages_thread_key_idx` ON `external_agent_messages` (`thread_id`,`stable_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `external_agent_messages_thread_order_idx` ON `external_agent_messages` (`thread_id`,`ordinal`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_session_external_threads` (`session_id` text PRIMARY KEY NOT NULL, `external_thread_id` text NOT NULL, `import_version` integer NOT NULL, `created_at` integer NOT NULL, FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade, FOREIGN KEY (`external_thread_id`) REFERENCES `external_agent_threads`(`id`) ON UPDATE no action ON DELETE restrict);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_session_external_threads_thread_idx` ON `agent_session_external_threads` (`external_thread_id`);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `external_agent_threads_fts` USING fts5(`thread_id` UNINDEXED, `title`, `body`, tokenize='unicode61');
