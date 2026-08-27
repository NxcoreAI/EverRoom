CREATE TABLE IF NOT EXISTS `room_entity_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`fact_id` text NOT NULL,
	`content` text NOT NULL,
	`type` text DEFAULT '属性' NOT NULL,
	`entity_ids` text,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_version` integer NOT NULL,
	`evidence_group_key` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `room_entity_facts_room_source_fact_idx` ON `room_entity_facts` (`room_id`,`source_kind`,`source_id`,`fact_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `room_entity_facts_room_idx` ON `room_entity_facts` (`room_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `room_entity_facts_source_idx` ON `room_entity_facts` (`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `room_entity_facts_fact_idx` ON `room_entity_facts` (`fact_id`);
