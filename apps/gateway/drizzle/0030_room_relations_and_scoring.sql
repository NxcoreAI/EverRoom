CREATE TABLE `room_entity_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_version` integer NOT NULL,
	`evidence_group_key` text NOT NULL,
	`salience` real DEFAULT 0 NOT NULL,
	`relevance_factor` real DEFAULT 0 NOT NULL,
	`quality_level` text DEFAULT 'excluded' NOT NULL,
	`trusted` integer DEFAULT false NOT NULL,
	`evidence` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_entity_mentions_room_entity_source_idx` ON `room_entity_mentions` (`room_id`,`entity_id`,`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `room_entity_mentions_entity_idx` ON `room_entity_mentions` (`entity_id`);--> statement-breakpoint
CREATE INDEX `room_entity_mentions_room_idx` ON `room_entity_mentions` (`room_id`);--> statement-breakpoint
CREATE INDEX `room_entity_mentions_source_idx` ON `room_entity_mentions` (`source_kind`,`source_id`);--> statement-breakpoint
CREATE TABLE `room_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`room_a_id` text NOT NULL,
	`room_b_id` text NOT NULL,
	`auto_score` real DEFAULT 0 NOT NULL,
	`auto_type` text,
	`strength` text,
	`shared_source_count` integer DEFAULT 0 NOT NULL,
	`shared_entity_count` integer DEFAULT 0 NOT NULL,
	`direct_mention_count` integer DEFAULT 0 NOT NULL,
	`top_reasons` text,
	`scoring_version` integer DEFAULT 1 NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`manual_type` text,
	`manual_from_room_id` text,
	`manual_to_room_id` text,
	`manual_label` text,
	`manual_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_relations_pair_idx` ON `room_relations` (`room_a_id`,`room_b_id`);--> statement-breakpoint
CREATE INDEX `room_relations_room_a_idx` ON `room_relations` (`room_a_id`);--> statement-breakpoint
CREATE INDEX `room_relations_room_b_idx` ON `room_relations` (`room_b_id`);--> statement-breakpoint
CREATE INDEX `room_relations_updated_idx` ON `room_relations` (`updated_at`);--> statement-breakpoint
CREATE TABLE `room_source_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_version` integer NOT NULL,
	`source_title` text,
	`evidence_group_key` text NOT NULL,
	`role` text NOT NULL,
	`effective_weight` real DEFAULT 0 NOT NULL,
	`quality_level` text DEFAULT 'excluded' NOT NULL,
	`trusted` integer DEFAULT false NOT NULL,
	`score_reasons` text,
	`scoring_version` integer DEFAULT 1 NOT NULL,
	`entity_indexed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_source_memberships_room_source_idx` ON `room_source_memberships` (`room_id`,`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `room_source_memberships_source_idx` ON `room_source_memberships` (`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `room_source_memberships_group_idx` ON `room_source_memberships` (`evidence_group_key`);--> statement-breakpoint
CREATE INDEX `room_source_memberships_room_idx` ON `room_source_memberships` (`room_id`);--> statement-breakpoint
ALTER TABLE `entities` ADD `eligible_source_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `entities` ADD `trusted_source_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `entities` ADD `strong_source_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `entities` ADD `readiness_path` text;--> statement-breakpoint
ALTER TABLE `entities` ADD `scoring_version` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_doc_links` ADD `evidence_group_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_doc_links` ADD `role_weight` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_doc_links` ADD `source_weight` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_doc_links` ADD `quality_factor` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_doc_links` ADD `relevance_factor` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_doc_links` ADD `effective_weight` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_doc_links` ADD `quality_level` text DEFAULT 'excluded' NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_doc_links` ADD `trusted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_doc_links` ADD `strong` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_doc_links` ADD `score_reasons` text;--> statement-breakpoint
ALTER TABLE `entity_doc_links` ADD `scoring_version` integer DEFAULT 2 NOT NULL;