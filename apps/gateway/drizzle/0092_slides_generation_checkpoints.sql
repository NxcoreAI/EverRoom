CREATE TABLE `slides_generation_checkpoints` (
  `key` text PRIMARY KEY NOT NULL,
  `state` text NOT NULL,
  `updated_at` integer NOT NULL
);
