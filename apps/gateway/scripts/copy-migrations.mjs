import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/drizzle", { recursive: true });
await cp("drizzle", "dist/drizzle", { recursive: true, force: true });
