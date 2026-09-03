import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { agentRuns, gatewayMetadata, roomMemorySuppressions } from "../../infrastructure/database/schema.js";
import type { MemoryAtomicDto, MemoryService } from "./service.js";

const CURSOR_KEY = "memory.room-derive.v1:cursor";

/** MemoryCore /v3/atomic/query 的 limit 上限。 */
const PAGE_SIZE_MAX = 100;
const PAGE_SIZE_DEFAULT = 100;
const MAX_PER_DRAIN_DEFAULT = 200;
const INTERVAL_MS_DEFAULT = 300_000;

interface RoomMemoryDeriveLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface RoomMemoryDeriveWorkerOptions {
  intervalMs?: number;
  pageSize?: number;
  maxPerDrain?: number;
}

interface DeriveCursor {
  /** 已检查集的 updated_time 边界（MemoryCore 按 updated_time 过滤/排序，含端点）。 */
  updatedAt: string | null;
}

/**
 * 新 L1 记忆的 Room 自动绑定 worker：定时增量扫描 MemoryCore（listAtomic 的
 * timeStart=游标），对无归属且未压制的记忆做 provenance→run→roomId 推导，写
 * confidence=derived 归属行（快照随行落库，注入/工具取数与手动绑定同源）。
 *
 * 推导链：provenance.session.sessionId（agent 对话捕获时传的就是 gateway
 * agent_sessions.id）→ 该会话中 createdAt ≤ 记忆创建时间、最新一条带 roomId 的
 * run → resolveRoom 落合并链终点。合成 session id（wiki:/onboarding:）与无带
 * Room 的 run 都查不到映射行，属稳定终态，直接跳过不重试。
 *
 * 游标正确性（MemoryCore 固定 ORDER BY updated_time DESC 分页）：逐页向下扫保证
 * 「已检查集是结果集的连续前缀」——扫尽时游标上收到 max(examined)（避免每轮全量
 * 重扫）；失败或推导尝试触顶（maxPerDrain 只计真实尝试，跳过项不计——否则游标
 * 停在老位置时会被跳过项占满预算死循环）时，游标落在**首个未检查项**的
 * updated_time（DESC 序它比已检查项都旧，time_start 含端点保证下轮可见）实现
 * 同位重试/续扫。新提炼/被编辑的记忆 updated_time 最新、永远排在队首，必然被
 * 看到；同刻并列由「已有归属/压制行跳过」幂等吸收。将来增加 document 来源推导
 * 时需换游标 key 版本或清游标做一次性回填（旧 document 派生记忆的游标已越过）。
 */
export class RoomMemoryDeriveWorker {
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly memory: MemoryService,
    private readonly logger: RoomMemoryDeriveLogger,
    private readonly options: RoomMemoryDeriveWorkerOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), this.options.intervalMs ?? INTERVAL_MS_DEFAULT);
    this.timer.unref();
    void this.drain();
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drainPromise;
  }

  async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainPending().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async drainPending(): Promise<void> {
    // 每次 drain 自查：PUT /v1/memory/config 热换 client 后自动生效，未配置时空转。
    if (!this.memory.enabled) return;

    const pageSize = Math.min(this.options.pageSize ?? PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);
    const maxPerDrain = this.options.maxPerDrain ?? MAX_PER_DRAIN_DEFAULT;
    const cursor = this.readCursor();

    const examined: string[] = [];
    /** 首个未检查项（失败或触发 maxPerDrain）的 updated_time——下轮窗口必须含它。 */
    let stopAt: string | null = null;
    let exhausted = false;
    let offset = 0;
    let attributed = 0;
    // cap 只计真实推导尝试（provenance 是 HTTP 调用）；跳过已有归属/压制项是廉价的
    // 内存判断，不计入——否则游标停在老位置时每轮都会被跳过项占满预算，目标项
    // 永远轮不到（死循环停在同一边界）。
    let attempts = 0;

    try {
      while (attempts < maxPerDrain && stopAt === null) {
        let page;
        try {
          page = await this.memory.listAtomic({
            timeStart: cursor.updatedAt ?? undefined,
            limit: pageSize,
            offset,
          });
        } catch (error) {
          // 页拉取失败（MemoryCore 不可达等）：游标不动，下轮重试。
          this.logger.warn({ err: error }, "memory room derive scan failed");
          return;
        }
        if (page.items.length === 0) {
          exhausted = true;
          break;
        }

        const pageIds = page.items.map((item) => item.id);
        const suppressed = new Set(
          pageIds.length > 0
            ? this.db.select({ memoryId: roomMemorySuppressions.memoryId })
              .from(roomMemorySuppressions)
              .where(inArray(roomMemorySuppressions.memoryId, pageIds))
              .all()
              .map((row) => row.memoryId)
            : [],
        );

        for (const item of page.items) {
          // attachRoom 白送的归属信号：已有行（explicit 或 derived）一律跳过。
          if (item.roomId !== null || suppressed.has(item.id)) {
            examined.push(item.updatedAt);
            continue;
          }
          if (attempts >= maxPerDrain) {
            // DESC 序：未检查项都比已检查项旧，游标须落在它身上（含端点）下轮才可见。
            stopAt = item.updatedAt;
            break;
          }
          attempts += 1;
          try {
            if (await this.deriveOne(item)) attributed += 1;
            examined.push(item.updatedAt);
          } catch (error) {
            stopAt = item.updatedAt;
            this.logger.warn({ err: error, memoryId: item.id }, "memory room derive failed");
            break;
          }
        }

        // 失败或触顶：stopAt 已置位，停在边界等下轮。短页且整页检查完才是真正扫尽。
        if (stopAt !== null || page.items.length < pageSize) {
          if (stopAt === null) exhausted = true;
          break;
        }
        offset += page.items.length;
      }
    } finally {
      const next = stopAt ?? (examined.length > 0 && exhausted ? maxIso(examined) : null);
      if (next !== null) {
        this.writeCursor({ updatedAt: next });
        if (attributed > 0 || stopAt !== null) {
          this.logger.info(
            { examined: examined.length, attempts, attributed, retryFrom: stopAt, exhausted },
            "memory room derive drain finished",
          );
        }
      }
    }
  }

  /** 返回是否落了 derived 行。任何一步落空均为稳定终态，返回 false 不重试。 */
  private async deriveOne(item: MemoryAtomicDto): Promise<boolean> {
    const provenance = await this.memory.atomicProvenanceOrNull(item.id);
    if (!provenance) return false; // 记忆已删（404）→ 已处理。
    const sessionId = provenance.session?.sessionId;
    if (!sessionId) return false; // document 来源 / 无会话：本期终态跳过（见类注释）。

    const memoryCreatedAt = Date.parse(item.createdAt);
    if (!Number.isFinite(memoryCreatedAt)) return false;
    const run = this.db.select({ roomId: agentRuns.roomId })
      .from(agentRuns)
      .where(and(
        eq(agentRuns.sessionId, sessionId),
        isNotNull(agentRuns.roomId),
        lte(agentRuns.createdAt, new Date(memoryCreatedAt)),
      ))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1)
      .get();
    if (!run?.roomId) return false;

    const resolved = this.memory.resolveRoom(run.roomId);
    if (!resolved) return false; // Room 已软删/合并链断 → 终态跳过。

    this.memory.insertDerivedAttribution(item, sessionId, resolved);
    this.logger.info(
      { memoryId: item.id, roomId: resolved, sessionId },
      "memory room derive attributed",
    );
    return true;
  }

  private readCursor(): DeriveCursor {
    const row = this.db.select({ value: gatewayMetadata.value })
      .from(gatewayMetadata)
      .where(eq(gatewayMetadata.key, CURSOR_KEY))
      .get();
    if (!row?.value) return { updatedAt: null };
    try {
      const parsed = JSON.parse(row.value) as { updatedAt?: unknown };
      return typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : { updatedAt: null };
    } catch {
      return { updatedAt: null };
    }
  }

  private writeCursor(cursor: DeriveCursor): void {
    this.db.insert(gatewayMetadata)
      .values({ key: CURSOR_KEY, value: JSON.stringify(cursor), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: gatewayMetadata.key,
        set: { value: JSON.stringify(cursor), updatedAt: new Date() },
      })
      .run();
  }
}

function maxIso(values: string[]): string {
  return values.reduce((acc, value) => (value > acc ? value : acc));
}
