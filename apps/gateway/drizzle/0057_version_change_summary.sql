-- 版本变更概览（历史面板 AI 概览标题）：
-- 重要变更在保存时后台自动生成并落库；其余在打开历史面板时懒加载生成后回填。
ALTER TABLE `doc_versions` ADD `change_summary` text;--> statement-breakpoint
ALTER TABLE `doc_versions` ADD `change_summary_source` text;
