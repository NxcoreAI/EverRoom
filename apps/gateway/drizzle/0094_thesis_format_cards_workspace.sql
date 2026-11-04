-- 论文格式卡改按工作区隔离（Room 维度已随 0085/0086 下线）。
-- 存量卡片统一归入默认工作区：Room 与工作区之间没有可推断的对应关系，
-- 自定义工作区需要重新导入一次模版（导入后即归属该工作区）。
ALTER TABLE `thesis_format_cards` RENAME TO `thesis_format_cards_room_old`;--> statement-breakpoint
CREATE TABLE `thesis_format_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`format_card` text NOT NULL,
	`source_file_entry_id` text,
	`source_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `thesis_format_cards` (`id`,`workspace_id`,`format_card`,`source_file_entry_id`,`source_name`,`created_at`,`updated_at`)
	SELECT `id`, 'default', `format_card`, `source_file_entry_id`, `source_name`, `created_at`, `updated_at` FROM `thesis_format_cards_room_old`;--> statement-breakpoint
DROP TABLE `thesis_format_cards_room_old`;--> statement-breakpoint
CREATE UNIQUE INDEX `thesis_format_cards_workspace_source_idx` ON `thesis_format_cards` (`workspace_id`,`source_name`);