-- 工作区（Workspace）：会话的组织容器。
-- 默认工作区（id='default'）随迁移插入且永远存在；自定义工作区绑定本地目录。
-- agent_sessions.workspace_id 让会话归属工作区，存量会话回填到默认工作区。

CREATE TABLE `agent_workspaces` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `path` text,
  `kind` text DEFAULT 'custom' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `last_opened_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `agent_workspaces` (`id`, `name`, `path`, `kind`, `created_at`, `updated_at`, `last_opened_at`)
VALUES (
  'default',
  '默认工作区',
  NULL,
  'default',
  CAST((julianday('now') - 2440587.5) * 86400000 AS integer),
  CAST((julianday('now') - 2440587.5) * 86400000 AS integer),
  CAST((julianday('now') - 2440587.5) * 86400000 AS integer)
);--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `workspace_id` text;--> statement-breakpoint
CREATE INDEX `agent_sessions_workspace_idx` ON `agent_sessions` (`workspace_id`);--> statement-breakpoint
UPDATE `agent_sessions` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;