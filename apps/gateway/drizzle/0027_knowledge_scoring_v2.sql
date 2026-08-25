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