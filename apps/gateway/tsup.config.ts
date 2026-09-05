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
  noExternal: [/^(?!(better-sqlite3|@napi-rs\/canvas)$).*/, /^@nxcore\/connectors-module/],
  external: ["better-sqlite3", "@napi-rs/canvas"],
});
