import { eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { slidesGenerationCheckpoints } from "../../infrastructure/database/schema.js";
import type { GenerationBudgetSnapshot } from "./slides-generation-budget.js";
import type { LayouterExistingDeck } from "./slides-layout-tail.js";

export interface SlidesGenerationCheckpoint {
  batches: Record<string, Record<string, unknown>>;
  /**
   * 批次上次失败的具体缺陷（batchIndex → 错误文案），随 checkpoint 持久化：
   * 用户重试 generate 时把缺陷喂回 planner，避免整批从零盲排。
   */
  batchErrors?: Record<string, string[]>;
  deck?: LayouterExistingDeck;
  budget?: GenerationBudgetSnapshot;
  /** 整轮重生成凭据（slides-regenerate:{draftDocumentId}）：最近一次落页的已装配方案与 deck 进度。 */
  regen?: {
    plan: Record<string, unknown>;
    deck: { fileEntryId: string; originalName: string | null; appliedPages: number[]; totalPages: number };
    previewPages?: number;
  };
}

/** SQLite in production; an instance-local memory store for hosts without a database. */
export class SlidesGenerationCheckpointStore {
  private readonly memory = new Map<string, SlidesGenerationCheckpoint>();

  constructor(private readonly db?: GatewayDatabase) {}

  read(key: string): SlidesGenerationCheckpoint {
    const value = this.db
      ? this.db.select().from(slidesGenerationCheckpoints).where(eq(slidesGenerationCheckpoints.key, key)).get()?.state
      : this.memory.get(key);
    return structuredClone(value ?? { batches: {} });
  }

  patch(key: string, update: Partial<SlidesGenerationCheckpoint>): void {
    const write = () => {
      const previous = this.read(key);
      const state = { ...previous, ...update, batches: { ...previous.batches, ...update.batches } };
      if (this.db) {
        this.db.insert(slidesGenerationCheckpoints).values({ key, state, updatedAt: new Date() })
          .onConflictDoUpdate({ target: slidesGenerationCheckpoints.key, set: { state, updatedAt: new Date() } }).run();
      } else this.memory.set(key, structuredClone(state));
    };
    if (this.db) this.db.transaction(write);
    else write();
  }

  clear(key: string): void {
    if (this.db) this.db.delete(slidesGenerationCheckpoints).where(eq(slidesGenerationCheckpoints.key, key)).run();
    else this.memory.delete(key);
  }
}
