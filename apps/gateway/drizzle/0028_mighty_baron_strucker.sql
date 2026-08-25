ALTER TABLE `clipper_assets` ADD `reference_key` text NOT NULL;--> statement-breakpoint
CREATE INDEX `clipper_assets_reference_idx` ON `clipper_assets` (`reference_key`,`created_at`);