-- 记忆自动绑定 Room 的永久压制表。
-- 用户清除过归属行（explicit 或 derived）的记忆不再被推导 worker 自动绑回；
-- 手动重绑不受影响。行由 assignAtomicRoom 清除分支写入，deleteAtomic 随记忆清理。
CREATE TABLE IF NOT EXISTS `room_memory_suppressions` (
	`memory_id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`created_at` integer NOT NULL
);
