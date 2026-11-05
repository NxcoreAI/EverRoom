import { cp, mkdir, realpath, rm } from "node:fs/promises";
import { dirname } from "node:path";

await mkdir("dist/drizzle", { recursive: true });
await cp("drizzle", "dist/drizzle", { recursive: true, force: true });
await cp("package.json", "dist/package.json", { force: true });
// 运行时配置·工程默认层（打包后 bundle 在 dist/，逐级上溯从这里找到它）。
// ingest 策略与过滤规则默认层随 modules/ingest 一起下线，不再随包分发。
await cp("runtime-config.default.json", "dist/runtime-config.default.json", { force: true });
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

// pdfjs-dist 的代码被 tsup 内联进 bundle，但 pdf.ts 运行时用 createRequire 解析
// package.json 定位 cmaps/standard_fonts 静态目录（CJK 非嵌入字体 + 标准字体），
// 这两个目录必须以真实文件随包分发。
const pdfjsTarget = "dist/node_modules/pdfjs-dist";
await mkdir(pdfjsTarget, { recursive: true });
for (const entry of ["cmaps", "standard_fonts", "package.json"]) {
  await cp(`node_modules/pdfjs-dist/${entry}`, `${pdfjsTarget}/${entry}`, {
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

// @node-rs/jieba（长期记忆的中文分词）：tsup 外置后运行时按平台包解析 .node，
// 因此 JS 包与当前平台二进制都必须以真实文件随包分发（同 @napi-rs/canvas 的处理）。
const jiebaTarget = "dist/node_modules/@node-rs";
const jiebaPackageSource = await realpath("node_modules/@node-rs/jieba");
const jiebaSource = dirname(jiebaPackageSource);
await cp(jiebaPackageSource, `${jiebaTarget}/jieba`, {
  recursive: true,
  force: true,
  dereference: true,
});
const jiebaPlatformPackage = {
  "darwin-arm64": "jieba-darwin-arm64",
  "darwin-x64": "jieba-darwin-x64",
  "win32-x64": "jieba-win32-x64-msvc",
  "win32-arm64": "jieba-win32-arm64-msvc",
  "linux-x64": process.report.getReport().header.glibcVersionRuntime
    ? "jieba-linux-x64-gnu"
    : "jieba-linux-x64-musl",
  "linux-arm64": process.report.getReport().header.glibcVersionRuntime
    ? "jieba-linux-arm64-gnu"
    : "jieba-linux-arm64-musl",
}[platformKey];
if (!jiebaPlatformPackage) throw new Error(`Unsupported @node-rs/jieba platform: ${platformKey}`);
await cp(`${jiebaSource}/${jiebaPlatformPackage}`, `${jiebaTarget}/${jiebaPlatformPackage}`, {
  recursive: true,
  force: true,
  dereference: true,
});
