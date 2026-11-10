-- 本地文件夹来源每次应用启动都会重扫，历史上把 `updated_at` 一起刷成扫描时间。
-- 文件库/首页按「最近更新」只取 200 条，这些没被改动过的本地文件因此长期霸占
-- 第一页，用户自己上传的文件被挤到 200 名之外，看起来像「重启后上传的文件不见了」。
--
-- 一次性归位：本地文件夹条目的 updated_at 取「文件本身最后修改时间」与入库时间的
-- 较大者（两者都没有时退回入库时间）。治理后的重扫不再刷新 updated_at（见
-- files/service.ts registerImportedFile）。
UPDATE file_entries
SET updated_at = MAX(
  created_at,
  COALESCE(
    (SELECT v.source_modified_at FROM file_versions v WHERE v.id = file_entries.current_version_id),
    created_at
  )
)
WHERE source_kind = 'local-folder';
