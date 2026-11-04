-- 项目空间目录化（P0）：空间 = 磁盘上一个带 `space.everoffice` 的目录。
-- 设计见 docs/project-space-layout-plan.zh-CN.md。
--
-- 增列：
--   slug            目录名（ASCII slug）；老数据为 NULL，下次 ensureLayout 从标记回填
--   root_mode       目录归属模式；默认 managed（应用托管根 <dataDir>/Workspace）
--   layout_version  0 = 未初始化（首次打开/启动时 provision），1 = 当前布局
--   root_missing_at 目录被外部删除/移动的发现时间，用于 UI「目录离线」提示
--
-- 为什么是「重建表」而不是三条 ALTER ADD COLUMN：
-- SQLite 没有 `ADD COLUMN IF NOT EXISTS`，而 database-migrations 的单测会把
-- 时间戳在 pre-merge 游标之后的迁移整体重放一次（见 0094/0095 的同类处理）。
-- rename → create → copy → drop 的写法可重放：重放时旧表里的新列不会被复制，
-- 但 path 保留、layout_version 归 0，下一次 ensureLayout 会从 `space.everoffice`
-- 重新推出 slug / root_mode（自愈），不会丢空间与目录的绑定关系。

ALTER TABLE `agent_workspaces` RENAME TO `agent_workspaces_layout_old`;--> statement-breakpoint
CREATE TABLE `agent_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`goals` text,
	`path` text,
	`slug` text,
	`root_mode` text DEFAULT 'managed' NOT NULL,
	`layout_version` integer DEFAULT 0 NOT NULL,
	`root_missing_at` integer,
	`kind` text DEFAULT 'custom' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_opened_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `agent_workspaces`
	(`id`,`name`,`description`,`goals`,`path`,`kind`,`created_at`,`updated_at`,`last_opened_at`)
	SELECT `id`,`name`,`description`,`goals`,`path`,`kind`,`created_at`,`updated_at`,`last_opened_at`
	FROM `agent_workspaces_layout_old`;--> statement-breakpoint
DROP TABLE `agent_workspaces_layout_old`;--> statement-breakpoint
-- 同一个目录不能挂两个空间：路径唯一（NULL 不参与唯一约束）。
CREATE UNIQUE INDEX IF NOT EXISTS `agent_workspaces_path_idx` ON `agent_workspaces` (`path`) WHERE `path` IS NOT NULL;
