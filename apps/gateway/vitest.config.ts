import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const submodule = (p: string) =>
  resolve(__dirname, "../../submodules/everroom-connectors/gateway-module", p);

export default defineConfig({
  resolve: {
    alias: [
      // 宿主内测试：submodule 的 #gateway/* 类型缝解析到宿主真实实现
      { find: /^#gateway\/config$/, replacement: resolve(__dirname, "src/config.ts") },
      { find: /^#gateway\/database$/, replacement: resolve(__dirname, "src/infrastructure/database/client.ts") },
      { find: /^#gateway\/schema$/, replacement: resolve(__dirname, "src/infrastructure/database/schema.ts") },
      { find: /^@nxcore\/connectors-module$/, replacement: submodule("index.ts") },
      { find: /^@nxcore\/connectors-module\/(.*)$/, replacement: submodule("$1") },
    ],
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "src/modules/connector/**"],
  },
});
