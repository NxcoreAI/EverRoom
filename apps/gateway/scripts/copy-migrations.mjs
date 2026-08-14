import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/drizzle", { recursive: true });
await cp("drizzle", "dist/drizzle", { recursive: true, force: true });

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
