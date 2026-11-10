-- 每日洞察 / 每日日记：一天一条，版本化。
-- 设计见 docs/daily-journal-plan.zh-CN.md。
--
-- 只有两件事要记住：
--   1. journal_days 是「今天现在说到哪」的指针（status + current_entry_id + 证据指纹）；
--   2. journal_entries 是历史版本，同一天重写就 +1 版（跨天冻结，手动重写仍可再版）。
--
-- 为什么用 IF NOT EXISTS：database-migrations 的单测会把时间戳在 pre-merge 游标之后的
-- 迁移整体重放一次（见 0094/0096 的同类处理），这里的语句必须可重放。

CREATE TABLE IF NOT EXISTS `journal_days` (
	`date` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_entry_id` text,
	`source_fingerprint` text,
	`signal_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `journal_days_status_date_idx` ON `journal_days` (`status`,`date`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`version` integer NOT NULL,
	`trigger` text NOT NULL,
	`headline` text NOT NULL,
	`summary` text NOT NULL,
	`bullets` text NOT NULL,
	`actions` text NOT NULL,
	`evidence` text NOT NULL,
	`model` text,
	`source_fingerprint` text NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `journal_entries_date_version_idx` ON `journal_entries` (`date`,`version`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `journal_entries_date_idx` ON `journal_entries` (`date`,`created_at`);
