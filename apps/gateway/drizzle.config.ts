import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/infrastructure/database/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.NXCORE_GATEWAY_DATABASE_PATH ?? ".data/database/gateway.sqlite",
  },
});
