-- 主—子 Agent 分发：@ 本机 Agent 的子包分发记录。
-- 每条记录是一次分发的不可变子包快照（封印后落库）+ 终态结果，供任务详情与「Agent 产出」溯源。
CREATE TABLE `local_agent_dispatches` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL REFERENCES agent_sessions(id) ON DELETE cascade,
	`parent_run_id` text NOT NULL REFERENCES agent_runs(id) ON DELETE cascade,
	`agent_id` text NOT NULL,
	`display_name` text NOT NULL,
	`provider` text NOT NULL,
	`assignment` text NOT NULL,
	`shared_goal` text,
	`constraints` text NOT NULL DEFAULT '[]',
	`materials` text NOT NULL DEFAULT '[]',
	`package_json` text NOT NULL,
	`package_digest` text NOT NULL,
	`package_version` integer NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`result_text` text,
	`error_code` text,
	`error_message` text,
	`sub_run_id` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `local_agent_dispatches_parent_run_idx` ON `local_agent_dispatches` (`parent_run_id`);
--> statement-breakpoint
CREATE INDEX `local_agent_dispatches_session_created_idx` ON `local_agent_dispatches` (`session_id`, `created_at`);
