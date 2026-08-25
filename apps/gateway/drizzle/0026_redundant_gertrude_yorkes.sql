CREATE TABLE `parsed_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`file_version_id` text NOT NULL,
	`parser_revision` text NOT NULL,
	`format` text NOT NULL,
	`artifact` text NOT NULL,
	`markdown` text NOT NULL,
	`quality` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_version_id`) REFERENCES `file_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parsed_documents_version_revision_idx` ON `parsed_documents` (`file_version_id`,`parser_revision`);--> statement-breakpoint
CREATE INDEX `parsed_documents_format_created_idx` ON `parsed_documents` (`format`,`created_at`);