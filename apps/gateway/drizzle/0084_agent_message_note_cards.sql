-- 文档批注卡片：用户以批注队列发出的消息携带结构化展示数据（原文摘录 + 注释），
-- 气泡渲染成卡片而不是纯文本。ADD 写法可被 runAdditiveMigrationIdempotently 的
-- ALTER 守卫安全重放。
ALTER TABLE `agent_messages` ADD `note_cards` text;
