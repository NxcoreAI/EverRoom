-- 每日洞察：建议字段。洞察不只是记录，还要给下一步建议（总结 + 建议）。
-- 用 ADD（不带 COLUMN 关键字）的写法：runAdditiveMigrationIdempotently 的
-- ALTER 守卫正则只认 `ADD \`col\``，这样重放安全由既有守卫覆盖。
ALTER TABLE `journal_entries` ADD `advice` text;
