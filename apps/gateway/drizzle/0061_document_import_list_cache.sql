-- 连接器页全量列举缓存：每 (provider, connection_name) 一行，面板打开先回显
-- 上次结果再按需刷新，避免每次进入都全量拉取远端。
CREATE TABLE IF NOT EXISTS `document_import_list_cache` (
	`provider` text NOT NULL,
	`connection_name` text DEFAULT '' NOT NULL,
	`items_json` text DEFAULT '[]' NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY (`provider`, `connection_name`)
);
