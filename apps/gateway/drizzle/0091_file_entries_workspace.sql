-- 文件归属工作区：资料库/产物库按空间隔离。
-- 存量文件回填 default（id='default' 由 0089 保证存在）；新导入在入库时带
-- workspaceId（agent 会话产物 = 会话所属空间），NULL 由服务层归一为 default。

ALTER TABLE `file_entries` ADD `workspace_id` text;--> statement-breakpoint
UPDATE `file_entries` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
CREATE INDEX `file_entries_workspace_idx` ON `file_entries` (`workspace_id`);
