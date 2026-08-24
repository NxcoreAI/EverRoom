PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_doc_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`title` text DEFAULT '无标题文档' NOT NULL,
	`content_json` text,
	`content_schema_version` integer DEFAULT 1 NOT NULL,
	`source_transaction_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_doc_versions`("id", "document_id", "version", "title", "content_json", "content_schema_version", "source_transaction_id", "created_at") SELECT "id", "document_id", "version", "title", "content_json", "content_schema_version", "source_transaction_id", "created_at" FROM `doc_versions`;--> statement-breakpoint
DROP TABLE `doc_versions`;--> statement-breakpoint
ALTER TABLE `__new_doc_versions` RENAME TO `doc_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `doc_versions_document_version_idx` ON `doc_versions` (`document_id`,`version`);
--> statement-breakpoint
-- Existing Yjs-complete histories can release non-checkpoint snapshots
-- immediately; keep the current version as a fast-read snapshot.
UPDATE `doc_versions`
SET `content_json` = NULL
WHERE `version` <> (
  SELECT `version` FROM `documents` WHERE `documents`.`id` = `doc_versions`.`document_id`
)
AND EXISTS (
  SELECT 1 FROM `document_yjs_versions`
  WHERE `document_yjs_versions`.`document_id` = `doc_versions`.`document_id`
    AND `document_yjs_versions`.`version` = `doc_versions`.`version`
    AND `document_yjs_versions`.`backfilled` = 1
)
AND NOT EXISTS (
  SELECT 1 FROM `document_yjs_versions`
  WHERE `document_yjs_versions`.`document_id` = `doc_versions`.`document_id`
    AND `document_yjs_versions`.`version` = `doc_versions`.`version`
    AND `document_yjs_versions`.`checkpoint_id` IS NOT NULL
)
AND NOT EXISTS (
  SELECT 1
  FROM `doc_versions` AS history_versions
  LEFT JOIN `document_yjs_versions` AS history_yjs
    ON history_yjs.`document_id` = history_versions.`document_id`
    AND history_yjs.`version` = history_versions.`version`
  WHERE history_versions.`document_id` = `doc_versions`.`document_id`
    AND (history_yjs.`version` IS NULL OR history_yjs.`backfilled` = 0)
);
