CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`aliases` text,
	`kind` text DEFAULT '主题' NOT NULL,
	`summary` text,
	`status` text DEFAULT 'weak' NOT NULL,
	`room_id` text,
	`evidence_score` real DEFAULT 0 NOT NULL,
	`source_count` integer DEFAULT 0 NOT NULL,
	`centroid` text,
	`centroid_docs` integer DEFAULT 0 NOT NULL,
	`centroid_model` text,
	`merged_from` text,
	`last_linked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `entities_status_idx` ON `entities` (`status`);--> statement-breakpoint
CREATE INDEX `entities_name_idx` ON `entities` (`name`);--> statement-breakpoint
CREATE TABLE `entity_doc_links` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_version` integer NOT NULL,
	`role` text NOT NULL,
	`salience` real DEFAULT 0 NOT NULL,
	`evidence` text,
	`decided_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entity_doc_links_entity_source_idx` ON `entity_doc_links` (`entity_id`,`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `entity_doc_links_source_idx` ON `entity_doc_links` (`source_kind`,`source_id`);--> statement-breakpoint
ALTER TABLE `rooms` ADD `entity_id` text;--> statement-breakpoint
-- 存量 rooms 种子化为已晋升实体（ED4：路由到现有 Room 与命中弱实体共用同一套解析机制）。
-- id 取 `ent-room-<roomId>`（确定性，重跑幂等）；user Room 的资料归属仍走 documents.roomId。
INSERT INTO `entities` (`id`, `name`, `aliases`, `kind`, `summary`, `status`, `room_id`, `created_at`, `updated_at`)
SELECT
	'ent-room-' || `id`,
	`title`,
	`aliases`,
	`kind`,
	`summary`,
	'room',
	`id`,
	COALESCE(`created_at`, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
	COALESCE(`updated_at`, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
FROM `rooms`
WHERE `deleted_at` IS NULL;--> statement-breakpoint
UPDATE `rooms` SET `entity_id` = 'ent-room-' || `id` WHERE `deleted_at` IS NULL;