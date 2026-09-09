-- 批量导入"创建新的"选项：mode=room 且 force_new=true 时跳过来源去重，同来源一律新建文档。
ALTER TABLE `document_import_batches` ADD `force_new` integer DEFAULT false NOT NULL;
