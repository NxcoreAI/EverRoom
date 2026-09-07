-- 章节刻度线 hover 的 AI 章节预览：
-- 渲染层 hover 时提取章节正文（markdown）+ SHA-256 随请求携带；
-- 网关按 (document_id, block_id) 持久缓存，content_hash 命中不重调 LLM。
-- 生成只写本表，不影响 content_json / version（预览绝不修改正文）。
CREATE TABLE `document_section_previews` (
	`document_id` text NOT NULL,
	`block_id` text NOT NULL,
	`heading_text` text NOT NULL,
	`preview_text` text NOT NULL,
	`content_hash` text NOT NULL,
	`generated_at` integer NOT NULL,
	PRIMARY KEY (`document_id`, `block_id`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
