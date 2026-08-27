CREATE TABLE `external_call_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_scope` text NOT NULL,
	`subject_id` text NOT NULL,
	`service` text NOT NULL,
	`period` text NOT NULL,
	`call_limit` integer NOT NULL,
	`warning_threshold` integer NOT NULL,
	`enforcement` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_call_policies_subject_idx` ON `external_call_policies` (`subject_scope`,`subject_id`,`service`,`period`);
--> statement-breakpoint
CREATE TABLE `external_call_usage` (
	`policy_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`reserved_calls` integer DEFAULT 0 NOT NULL,
	`consumed_calls` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`policy_id`, `period_start`),
	FOREIGN KEY (`policy_id`) REFERENCES `external_call_policies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `external_call_usage_period_idx` ON `external_call_usage` (`period_start`);
--> statement-breakpoint
CREATE TABLE `external_call_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_ids` text NOT NULL,
	`service` text NOT NULL,
	`tool` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `external_call_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_scope` text NOT NULL,
	`subject_id` text NOT NULL,
	`workspace_id` text,
	`user_id` text,
	`service` text NOT NULL,
	`tool` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`source` text NOT NULL,
	`run_id` text,
	`correlation_id` text,
	`reserved_calls` integer NOT NULL,
	`consumed_calls` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`outcome` text NOT NULL,
	`failure_code` text
);
--> statement-breakpoint
CREATE INDEX `external_call_audits_subject_idx` ON `external_call_audits` (`subject_scope`,`subject_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `external_call_audits_service_idx` ON `external_call_audits` (`service`,`occurred_at`);
