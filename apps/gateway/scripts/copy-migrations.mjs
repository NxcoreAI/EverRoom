import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/drizzle", { recursive: true });
await cp("drizzle", "dist/drizzle", { recursive: true, force: true });
await cp("package.json", "dist/package.json", { force: true });
// 策略·工程默认层（打包后 bundle 在 dist/，逐级上溯从这里找到它）
await cp("ingest-policy-defaults.json", "dist/ingest-policy-defaults.json", { force: true });
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
