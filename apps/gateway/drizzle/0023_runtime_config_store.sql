CREATE TABLE `runtime_config_store` (
	`source` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`config_version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
