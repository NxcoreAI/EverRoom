import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin/serve.ts", "src/bin/migrate.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ["better-sqlite3"],
});
