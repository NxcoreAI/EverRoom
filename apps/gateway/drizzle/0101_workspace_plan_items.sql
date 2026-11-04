-- 工作空间「计划」：任务（todo）+ 事件流。
-- 设计见 docs/workspace-plan-task-design.zh-CN.md。
--
-- 两件事要记住：
--   1. workspace_plan_items 是任务本体（状态/负责人/排序/材料引用/认领租约）；
--   2. workspace_plan_item_events 是因果（谁在什么时候为什么改了它），
--      卡片时间线与 Agent 认领包的 history 都取自这里。
--
-- 为什么用 IF NOT EXISTS：database-migrations 的单测会把时间戳在 pre-merge 游标之后的
-- 迁移整体重放一次（见 0094/0096/0097 的同类处理），语句必须可重放。

CREATE TABLE IF NOT EXISTS `workspace_plan_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`acceptance` text,
	`constraints` text,
	`status` text DEFAULT 'todo' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`owner_kind` text DEFAULT 'unassigned' NOT NULL,
	`owner_agent_id` text,
	`assignee_session_id` text,
	`last_run_id` text,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_by_agent_id` text,
	`due_at` integer,
	`rank` text NOT NULL,
	`tags` text,
	`checklist` text,
	`refs` text,
	`blocked_by` text,
	`result_summary` text,
	`close_reason` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`lease_heartbeat_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plan_items_ws_status_rank_idx` ON `workspace_plan_items` (`workspace_id`,`status`,`rank`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plan_items_ws_updated_idx` ON `workspace_plan_items` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plan_items_assignee_idx` ON `workspace_plan_items` (`assignee_session_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plan_items_lease_idx` ON `workspace_plan_items` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workspace_plan_item_events` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`from_status` text,
	`to_status` text,
	`summary` text NOT NULL,
	`payload` text,
	`session_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `workspace_plan_items`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plan_events_item_idx` ON `workspace_plan_item_events` (`item_id`,`created_at`);
