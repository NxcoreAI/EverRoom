#!/usr/bin/env node

import { MigrationFailureError } from "@nxcore/migration-kit";
import { loadConfig } from "../config.js";
import { loadEnvironment } from "../load-environment.js";
import { createServer } from "../server/create-server.js";
import {
  removeRuntimeManifest,
  removeRuntimeManifestSync,
  writeRuntimeManifest,
} from "../server/runtime-manifest.js";

loadEnvironment();
const config = loadConfig();

let app: Awaited<ReturnType<typeof createServer>>;
try {
  app = await createServer(config);
} catch (error) {
  if (error instanceof MigrationFailureError) {
    // 桌面端按退出码 78 + stderr 标记识别「数据迁移失败」，弹窗提示后停在安全状态。
    process.stderr.write(`${error.message}\n`);
    process.exit(78);
  }
  throw error;
}

const address = await app.listen({ host: config.host, port: config.port });
await writeRuntimeManifest(config.runtimeManifestPath, {
  pid: process.pid,
  baseUrl: address,
  token: config.authToken,
  startedAt: new Date().toISOString(),
  version: "0.1.0",
});

app.log.info({ address, manifestPath: config.runtimeManifestPath }, "gateway ready");

process.once("exit", () => removeRuntimeManifestSync(config.runtimeManifestPath));

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "gateway shutting down");

  try {
    await app.close();
    await removeRuntimeManifest(config.runtimeManifestPath);
    process.exitCode = 0;
  } catch (error) {
    app.log.error({ err: error }, "gateway shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
