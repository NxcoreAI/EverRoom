#!/usr/bin/env node

import { loadConfig } from "../config.js";
import { loadEnvironment } from "../load-environment.js";
import { createCursorCompletionServer } from "../server/create-cursor-completion-server.js";
import {
  removeRuntimeManifest,
  removeRuntimeManifestSync,
  writeRuntimeManifest,
} from "../server/runtime-manifest.js";

loadEnvironment();
process.title = "EverRoom Cursor Completion";
const config = loadConfig();
const app = await createCursorCompletionServer(config);

const address = await app.listen({ host: config.host, port: config.port });
await writeRuntimeManifest(config.runtimeManifestPath, {
  pid: process.pid,
  baseUrl: address,
  token: config.authToken,
  startedAt: new Date().toISOString(),
  version: "0.1.0",
});

app.log.info(
  { address, manifestPath: config.runtimeManifestPath },
  "cursor completion service ready",
);

process.once("exit", () => removeRuntimeManifestSync(config.runtimeManifestPath));

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "cursor completion service shutting down");

  try {
    await app.close();
    await removeRuntimeManifest(config.runtimeManifestPath);
    process.exitCode = 0;
  } catch (error) {
    app.log.error({ err: error }, "cursor completion service shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
