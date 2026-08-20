CREATE INDEX IF NOT EXISTS `jobs_type_status_created_idx` ON `jobs` (`type`,`status`,`created_at`);
