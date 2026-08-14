import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../infrastructure/database/schema.js";

declare module "fastify" {
  interface FastifyInstance {
    db: BetterSQLite3Database<typeof schema>;
    authToken: string;
  }
}
