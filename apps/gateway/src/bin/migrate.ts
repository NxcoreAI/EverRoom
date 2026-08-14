#!/usr/bin/env node

import { loadConfig } from "../config.js";
import { loadEnvironment } from "../load-environment.js";
import { createDatabase } from "../infrastructure/database/client.js";

loadEnvironment();
const config = loadConfig();
const { sqlite } = createDatabase(config.databasePath, config.migrationsDir);
sqlite.close();

process.stdout.write(`Database migrated: ${config.databasePath}\n`);
