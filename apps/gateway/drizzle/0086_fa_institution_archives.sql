CREATE TABLE `fa_funds` (
	`id` text PRIMARY KEY NOT NULL,
	`institution_room_id` text NOT NULL,
	`name` text NOT NULL,
	`sequence` text,
	`currency` text,
	`vintage_year` integer,
	`target_size` real,
	`size_unit` text,
	`investment_period_end` integer,
	`constraints` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`source_kind` text,
	`source_id` text,
	`confirmed_by` text,
	`confirmed_at` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `fa_funds_institution_idx` ON `fa_funds` (`institution_room_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `fa_funds_institution_name_idx` ON `fa_funds` (`institution_room_id`,`name`);
--> statement-breakpoint
CREATE TABLE `fa_investments` (
	`id` text PRIMARY KEY NOT NULL,
	`institution_room_id` text NOT NULL,
	`fund_id` text,
	`portfolio_company` text NOT NULL,
	`project_room_id` text,
	`round` text,
	`invested_on` text,
	`role` text DEFAULT 'unknown' NOT NULL,
	`ticket_size` real,
	`ticket_currency` text,
	`relation_to_portfolio` text DEFAULT 'unknown' NOT NULL,
	`source_kind` text,
	`source_id` text,
	`source_url` text,
	`confirmed_by` text,
	`confirmed_at` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `fa_investments_institution_idx` ON `fa_investments` (`institution_room_id`);
--> statement-breakpoint
CREATE INDEX `fa_investments_project_idx` ON `fa_investments` (`project_room_id`);
--> statement-breakpoint
CREATE INDEX `fa_investments_company_idx` ON `fa_investments` (`portfolio_company`);
--> statement-breakpoint
CREATE UNIQUE INDEX `fa_investments_dedup_idx` ON `fa_investments` (`institution_room_id`,`portfolio_company`,`round`,`invested_on`);
--> statement-breakpoint
CREATE TABLE `fa_positions` (
	`id` text PRIMARY KEY NOT NULL,
	`person_room_id` text NOT NULL,
	`institution_room_id` text NOT NULL,
	`title` text,
	`from_year` integer,
	`to_year` integer,
	`ic_member` integer,
	`can_lead` integer,
	`sectors` text,
	`source_kind` text,
	`source_id` text,
	`confirmed_by` text,
	`confirmed_at` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `fa_positions_person_idx` ON `fa_positions` (`person_room_id`);
--> statement-breakpoint
CREATE INDEX `fa_positions_institution_idx` ON `fa_positions` (`institution_room_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `fa_positions_pair_title_idx` ON `fa_positions` (`person_room_id`,`institution_room_id`,`title`);
--> statement-breakpoint
ALTER TABLE `room_entity_facts` ADD `grade` text DEFAULT 'opinion' NOT NULL;
--> statement-breakpoint
ALTER TABLE `room_entity_facts` ADD `numeric` text;
--> statement-breakpoint
CREATE INDEX `room_entity_facts_room_grade_idx` ON `room_entity_facts` (`room_id`,`grade`);
--> statement-breakpoint
CREATE TABLE `fa_meeting_feedbacks` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`source_kind` text,
	`source_id` text,
	`institution_room_id` text,
	`person_room_id` text,
	`meeting_at` text,
	`disposition` text DEFAULT 'unknown' NOT NULL,
	`pass_reasons` text,
	`reopen_conditions` text,
	`project_updates` text,
	`person_signals` text,
	`institution_signals` text,
	`meeting_notes` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`confirmed_by` text,
	`confirmed_at` integer,
	`apply_result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `fa_meeting_feedbacks_room_idx` ON `fa_meeting_feedbacks` (`room_id`,`status`,`deleted_at`);
--> statement-breakpoint
CREATE INDEX `fa_meeting_feedbacks_institution_idx` ON `fa_meeting_feedbacks` (`institution_room_id`);
--> statement-breakpoint
CREATE INDEX `fa_meeting_feedbacks_source_idx` ON `fa_meeting_feedbacks` (`source_kind`,`source_id`);
