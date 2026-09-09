-- 连接器页批量导入：一次批量一行，逐项结果内联 items_json（≤50 项整行读写）。
CREATE TABLE IF NOT EXISTS `document_import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`owner_id` text DEFAULT 'local-user' NOT NULL,
	`provider` text NOT NULL,
	`connection_name` text,
	`mode` text NOT NULL,
	`target_room_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`total` integer NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`succeeded` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`items_json` text DEFAULT '[]' NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_import_batches_owner_created_idx` ON `document_import_batches` (`owner_id`,`created_at`);
