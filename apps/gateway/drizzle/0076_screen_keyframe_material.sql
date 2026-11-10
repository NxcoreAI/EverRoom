ALTER TABLE `screen_keyframes` ADD `material_hash` text;
--> statement-breakpoint
CREATE INDEX `screen_keyframes_material_idx` ON `screen_keyframes` (`material_hash`);
