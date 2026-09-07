-- 文档速览（文章级 AI 摘要）：
-- 首次打开文档时生成「主题/要点/结论」三段式速览并落库；正文更新后由用户手动重新生成。
-- 生成只写这 3 列，不影响 content_json / version（速览绝不修改正文）。
ALTER TABLE `documents` ADD `overview_text` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `overview_version` integer;--> statement-breakpoint
ALTER TABLE `documents` ADD `overview_generated_at` integer;
