import { defineConfig } from "tsup";

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
  splitting: false,
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
  noExternal: [/^(?!better-sqlite3$).*/],
  external: ["better-sqlite3"],
});
