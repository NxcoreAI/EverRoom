import { defineConfig } from "tsup";
import { resolve } from "node:path";

const submoduleGateway = (p: string) =>
  resolve(__dirname, "../../submodules/everroom-connectors/gateway-module", p);

export default defineConfig({
  entry: [
    "src/bin/serve.ts",
    "src/bin/cursor-completion-serve.ts",
    "src/bin/migrate.ts",
  ],
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  splitting: true,
  banner: {
    js: [
      "import { createRequire as __nxcoreCreateRequire } from 'node:module';",
      "import { fileURLToPath as __nxcoreFileURLToPath } from 'node:url';",
      "import { dirname as __nxcoreDirname } from 'node:path';",
      "globalThis.require = __nxcoreCreateRequire(import.meta.url);",
      "globalThis.__filename = __nxcoreFileURLToPath(import.meta.url);",
      "globalThis.__dirname = __nxcoreDirname(globalThis.__filename);",
    ].join("\n"),
  },
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      "@nxcore/connectors-module": submoduleGateway("."),
    };
  },
  // @node-rs/jieba 是原生模块（.node 二进制随平台包分发），必须外置：
  // 内联后运行时 require('@node-rs/jieba-darwin-arm64') 会解析失败。
  // 注意子路径（@node-rs/jieba/dict.js）也要豁免：dict.js 用 __dirname 定位
  // dict.txt/idf.txt，内联后 __dirname 指向产物目录，打包后启动即 ENOENT。
  noExternal: [
    /^(?!(better-sqlite3|@napi-rs\/canvas|@node-rs\/jieba(?:\/.*)?)$).*/,
    /^@nxcore\/connectors-module/,
  ],
  external: ["better-sqlite3", "@napi-rs/canvas", "@node-rs/jieba"],
});
