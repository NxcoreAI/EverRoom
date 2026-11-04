-- 工作区概览元数据：项目描述 + 目标列表。
-- description 为 NULL 表示未填写；goals 以 JSON 文本存放，NULL 与 '[]' 都按空数组暴露。
ALTER TABLE `agent_workspaces` ADD `description` text;--> statement-breakpoint
ALTER TABLE `agent_workspaces` ADD `goals` text;
