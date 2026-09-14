-- 板块归位 R1：资料与产物分离。
-- documents.origin：native=用户在 EverRoom 创建（产物库）；import=外部导入（工作资料）。
-- 存量回填：飞书/Notion 导入关联（含再次导入的候选文档）与 Obsidian 投影绑定都是外部导入。
ALTER TABLE `documents` ADD `origin` text NOT NULL DEFAULT 'native';
--> statement-breakpoint
UPDATE `documents` SET `origin` = 'import' WHERE `id` IN (
  SELECT `document_id` FROM `document_room_imports`
  UNION
  SELECT `candidate_document_id` FROM `document_room_imports` WHERE `candidate_document_id` IS NOT NULL
  UNION
  SELECT `document_id` FROM `external_document_bindings`
);
