-- P0-2d：document_operations.room_id 改为可空（工作区级操作没有归属 Room）。
-- SQLite 无法直接 DROP NOT NULL，只能重建表。重建必须在事务内完成，而
-- PRAGMA foreign_keys 在事务内是空操作，DROP TABLE 会级联删除四张子表的行
-- （document_operation_items / _commands / _events / external_document_patch_preparations），
-- 因此先把子表快照到临时表，重建父表后再原样恢复。
CREATE TEMP TABLE `__backup_document_operation_items` AS SELECT * FROM `document_operation_items`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_document_operation_commands` AS SELECT * FROM `document_operation_commands`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_document_operation_events` AS SELECT * FROM `document_operation_events`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_external_document_patch_preparations` AS SELECT * FROM `external_document_patch_preparations`;--> statement-breakpoint
CREATE TABLE `__new_document_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`capability_id` text NOT NULL,
	`capability_version` integer NOT NULL,
	`interaction_mode` text NOT NULL,
	`presenter_key` text NOT NULL,
	`room_id` text,
	`document_id` text,
	`document_title` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`base_version` integer,
	`status` text DEFAULT 'created' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`summary` text NOT NULL,
	`input` text NOT NULL,
	`result` text,
	`conflict_version` integer,
	`error` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_document_operations` (`id`, `capability_id`, `capability_version`, `interaction_mode`, `presenter_key`, `room_id`, `document_id`, `document_title`, `agent_session_id`, `run_id`, `base_version`, `status`, `revision`, `summary`, `input`, `result`, `conflict_version`, `error`, `expires_at`, `created_at`, `updated_at`, `completed_at`) SELECT `id`, `capability_id`, `capability_version`, `interaction_mode`, `presenter_key`, `room_id`, `document_id`, `document_title`, `agent_session_id`, `run_id`, `base_version`, `status`, `revision`, `summary`, `input`, `result`, `conflict_version`, `error`, `expires_at`, `created_at`, `updated_at`, `completed_at` FROM `document_operations`;--> statement-breakpoint
DROP TABLE `document_operations`;--> statement-breakpoint
ALTER TABLE `__new_document_operations` RENAME TO `document_operations`;--> statement-breakpoint
DELETE FROM `document_operation_items`;--> statement-breakpoint
INSERT INTO `document_operation_items` SELECT * FROM `__backup_document_operation_items`;--> statement-breakpoint
DELETE FROM `document_operation_commands`;--> statement-breakpoint
INSERT INTO `document_operation_commands` SELECT * FROM `__backup_document_operation_commands`;--> statement-breakpoint
DELETE FROM `document_operation_events`;--> statement-breakpoint
INSERT INTO `document_operation_events` SELECT * FROM `__backup_document_operation_events`;--> statement-breakpoint
DELETE FROM `external_document_patch_preparations`;--> statement-breakpoint
INSERT INTO `external_document_patch_preparations` SELECT * FROM `__backup_external_document_patch_preparations`;--> statement-breakpoint
DROP TABLE `__backup_document_operation_items`;--> statement-breakpoint
DROP TABLE `__backup_document_operation_commands`;--> statement-breakpoint
DROP TABLE `__backup_document_operation_events`;--> statement-breakpoint
DROP TABLE `__backup_external_document_patch_preparations`;--> statement-breakpoint
CREATE INDEX `document_operations_document_status_idx` ON `document_operations` (`document_id`,`status`);--> statement-breakpoint
CREATE INDEX `document_operations_room_status_idx` ON `document_operations` (`room_id`,`status`);--> statement-breakpoint
CREATE INDEX `document_operations_session_status_idx` ON `document_operations` (`agent_session_id`,`status`);--> statement-breakpoint
CREATE INDEX `document_operations_expiry_idx` ON `document_operations` (`status`,`expires_at`);
