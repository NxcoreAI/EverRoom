-- 「技能」页的启停状态。
-- 技能本体是随应用发布的只读资源（内置 Agent bundle 的 agents/<id>/skills/<dir>/SKILL.md，
-- 以及子 Agent 清单里的 skills），所以状态单独存一张表，按 skill_id 索引：
-- skill_id = `<kind>:<ownerId>:<目录名>`（如 builtin:main:document-export），不含 revision，
-- 重启与 Agent 改版后仍然对得上。缺省（无行）＝启用。
--
-- IF NOT EXISTS：分支合并留下的库可能已经把游标推到这里之后（迁移记录被重排/丢弃，
-- 但表已在），重放时不能因为「表已存在」整库启动失败。空表形态与建表完全一致。

CREATE TABLE IF NOT EXISTS `agent_skill_states` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
