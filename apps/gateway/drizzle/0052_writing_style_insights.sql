-- 协作轮洞察（写作风格 v2：横幅确认式沉淀）。
-- 一轮文档协作安静收尾后，把该轮行为信号蒸馏成偏好陈述待用户确认；
-- 确认后并入画像（用户显式意图层），稍后可回记忆页找回。
CREATE TABLE IF NOT EXISTS `writing_style_insights` (
	`id` text PRIMARY KEY NOT NULL,
	`summary` text NOT NULL,
	`signal_ids` text,
	`status` text NOT NULL DEFAULT 'pending',
	`llm_generated` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `writing_style_insights_status_idx` ON `writing_style_insights` (`status`);
