-- 文档索引回溯 worker 的游标扫描按 updated_at 升序推进；documents 表此前
-- 无二级索引，扫描是全表排序。加索引对齐 context_rooms_updated_idx 先例。
CREATE INDEX IF NOT EXISTS `documents_updated_idx` ON `documents` (`updated_at`);
