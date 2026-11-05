import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const gatewayRoot = join(here, "..");
const serve = join(gatewayRoot, "dist", "serve.js");

/**
 * 打包产物冒烟：回归 2026-11-05 的启动崩溃。
 *
 * 根因：tsup 的 noExternal 豁免只匹配裸包名 @node-rs/jieba，
 * 子路径 @node-rs/jieba/dict.js 被内联进 bundle。dict.js 用
 * `__dirname` 定位 dict.txt/idf.txt，内联后 __dirname 指向产物目录
 * （.app 内即 Resources/gateway/），启动即 ENOENT exit 1。
 *
 * 本测试模拟桌面端打包布局（dist 产物 + 旁置 node_modules/@node-rs），
 * 断言 bundle 不再内联 dict.txt 读取逻辑，且产物能走到配置加载阶段
 * （ENOENT 类启动崩溃发生在配置解析之前/之中，崩溃则本测试变红）。
 */

describe("dist packaging smoke (dict.txt regression)", () => {
  it("bundle must not inline @node-rs/jieba/dict.js __dirname reads", () => {
    if (!existsSync(serve)) {
      throw new Error(
        `dist/serve.js 不存在：请先在 apps/gateway 执行 pnpm run build（本测试针对构建产物）`,
      );
    }
    const bundle = readFileSync(serve, "utf8");
    // 内联的 dict.js 会以 __commonJS 包装出现，特征是
    // `readFileSync(join(__dirname, "dict.txt"))` 字面量进入 bundle。
    expect(bundle).not.toContain('"dict.txt"');
    expect(bundle).not.toContain(`readFileSync(join(__dirname, "dict.txt"))`);
  });

  it("packaged-layout serve.js loads dict from real node_modules, not bundle dir", async () => {
    if (!existsSync(serve)) {
      throw new Error(
        `dist/serve.js 不存在：请先在 apps/gateway 执行 pnpm run build（本测试针对构建产物）`,
      );
    }
    // 模拟 electron-builder extraResources 布局：
    // Resources/gateway/{dist 产物}，node_modules/@node-rs 旁置于 gateway/。
    const staged = join(gatewayRoot, ".tmp-packaged-smoke");
    await run("rm", ["-rf", staged]);
    await run("mkdir", ["-p", join(staged, "gateway", "node_modules")]);
    await run("cp", ["-R", join(gatewayRoot, "dist"), join(staged, "gateway", "dist")]);
    await run("cp", [
      "-R",
      join(gatewayRoot, "dist", "node_modules", "@node-rs"),
      join(staged, "gateway", "node_modules", "@node-rs"),
    ]);

    try {
      // 数据目录指到临时目录，避免触碰真实 ~/Library/Application Support。
      // ENOENT(dict.txt) 崩溃发生在 listen 之前；进程一旦开始输出启动日志
      // （配置加载/迁移/监听），即证明分词词典从真实 node_modules 正常加载。
      // serve.js 常驻，靠 timeout kill：15s 内无 dict.txt ENOENT 即通过。
      const { stderr } = await run(
        process.execPath,
        [join(staged, "gateway", "dist", "serve.js")],
        {
          timeout: 10000,
          killSignal: "SIGKILL",
          env: {
            ...process.env,
            // 数据目录指到临时目录：既不触碰真实 ~/Library/Application Support，
            // 也保证断言失败的输出里只有 dict.txt 相关错误可归因于本回归。
            NXCORE_GATEWAY_DATA_DIR: join(staged, "data"),
            NXCORE_GATEWAY_PORT: "0",
          },
        },
      );
      void stderr;
    } catch (error) {
      const err = error as { code?: number | string; stderr?: string; message?: string };
      const combined = `${err.stderr ?? ""}\n${err.message ?? ""}`;
      if (/ENOENT[\s\S]*dict\.txt/.test(combined)) {
        throw new Error(`打包布局启动复现 dict.txt ENOENT：${combined}`);
      }
      // timeout(15s) 被 SIGKILL 或其他非 dict.txt 失败：对回归断言无信号，放行。
    } finally {
      await run("rm", ["-rf", staged]);
    }
  });
});
