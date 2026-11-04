import { eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { slidesGenerationCheckpoints } from "../../infrastructure/database/schema.js";
import type { GenerationBudgetSnapshot } from "./slides-generation-budget.js";
import type { LayouterExistingDeck } from "./slides-layout-tail.js";

export interface SlidesGenerationCheckpoint {
  batches: Record<string, Record<string, unknown>>;
  deck?: LayouterExistingDeck;
  budget?: GenerationBudgetSnapshot;
}

/** SQLite in production; an instance-local store for hosts without a database. */
export class SlidesGenerationCheckpointStore {
  private readonly entries = new Map<string, SlidesGenerationCheckpoint>();

  constructor(private readonly db?: GatewayDatabase) {}

  read(key: string): SlidesGenerationCheckpoint {
    const value = this.db
      ? this.db.select().from(slidesGenerationCheckpoints).where(eq(slidesGenerationCheckpoints.key, key)).get()?.state
      : this.entries.get(key);
    return structuredClone(value ?? { batches: {} });
  }

  patch(key: string, update: Partial<SlidesGenerationCheckpoint>): void {
    const write = () => {
      const previous = this.read(key);
      const state = { ...previous, ...update, batches: { ...previous.batches, ...update.batches } };
      if (this.db) {
        this.db.insert(slidesGenerationCheckpoints).values({ key, state, updatedAt: new Date() })
          .onConflictDoUpdate({ target: slidesGenerationCheckpoints.key, set: { state, updatedAt: new Date() } }).run();
      } else this.entries.set(key, structuredClone(state));
    };
    if (this.db) this.db.transaction(write);
    else write();
  }

  clear(key: string): void {
    if (this.db) this.db.delete(slidesGenerationCheckpoints).where(eq(slidesGenerationCheckpoints.key, key)).run();
    else this.entries.delete(key);
  }
}
