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

// 进程级兜底：本地桌面服务宁可带病运行，也不因单个未处理异常整进程死亡
// （2026-10-17 排障：线上网关频繁死亡 + 渲染层反复爆红的根因）。后台任务
// 的异常已在各自 worker 层收口；这里只拦漏网之鱼，记日志（stderr 会经
// 桌面端转发进 Sentry）后继续服务，不做自杀式退出。
const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: toError(reason) }, "unhandled rejection kept alive");
});
process.on("uncaughtException", (error) => {
  app.log.error({ err: toError(error) }, "uncaught exception kept alive");
});

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
