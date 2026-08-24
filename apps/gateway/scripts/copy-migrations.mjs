import { cp, mkdir, realpath, rm } from "node:fs/promises";
import { dirname } from "node:path";

await mkdir("dist/drizzle", { recursive: true });
await cp("drizzle", "dist/drizzle", { recursive: true, force: true });
await cp("package.json", "dist/package.json", { force: true });
// 策略·工程默认层（打包后 bundle 在 dist/，逐级上溯从这里找到它）
await cp("ingest-policy-defaults.json", "dist/ingest-policy-defaults.json", { force: true });
await cp("runtime-config.default.json", "dist/runtime-config.default.json", { force: true });
// 过滤规则·工程默认层（同理，rules.ts 逐级上溯定位）
await cp("filter-rules-defaults.md", "dist/filter-rules-defaults.md", { force: true });
// Agent definitions are versioned application assets and ship with the Gateway.
await cp("../../agents", "dist/agents", { recursive: true, force: true });

await cp("node_modules/@fastify/swagger-ui/static", "dist/static", {
  recursive: true,
  force: true,
});

const sqliteTarget = "dist/node_modules/better-sqlite3";
await mkdir(sqliteTarget, { recursive: true });
for (const entry of ["lib", "prebuilds", "LICENSE", "package.json"]) {
  await cp(`node_modules/better-sqlite3/${entry}`, `${sqliteTarget}/${entry}`, {
    recursive: true,
    force: true,
  });
}

// unpdf uses @napi-rs/canvas only for server-side PDF rendering. Keep the
// native package external to the bundle and ship the current platform build.
const canvasTarget = "dist/node_modules/@napi-rs";
const canvasPackageSource = await realpath("node_modules/@napi-rs/canvas");
const canvasSource = dirname(canvasPackageSource);
await rm(canvasTarget, { recursive: true, force: true });
await mkdir(canvasTarget, { recursive: true });
await cp(canvasPackageSource, `${canvasTarget}/canvas`, {
  recursive: true,
  force: true,
  dereference: true,
});
const platformKey = `${process.platform}-${process.arch}`;
const platformPackage = {
  "darwin-arm64": "canvas-darwin-arm64",
  "darwin-x64": "canvas-darwin-x64",
  "win32-x64": "canvas-win32-x64-msvc",
  "win32-arm64": "canvas-win32-arm64-msvc",
  "linux-x64": process.report.getReport().header.glibcVersionRuntime
    ? "canvas-linux-x64-gnu"
    : "canvas-linux-x64-musl",
  "linux-arm64": process.report.getReport().header.glibcVersionRuntime
    ? "canvas-linux-arm64-gnu"
    : "canvas-linux-arm64-musl",
}[platformKey];
if (!platformPackage) throw new Error(`Unsupported @napi-rs/canvas platform: ${platformKey}`);
await cp(`${canvasSource}/${platformPackage}`, `${canvasTarget}/${platformPackage}`, {
  recursive: true,
  force: true,
  dereference: true,
});
