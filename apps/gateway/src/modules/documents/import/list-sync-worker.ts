import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import { documentImportListCache } from "../../../infrastructure/database/schema.js";
import type { ExternalDocumentProvider } from "@nxcore/agent-contract";
import type { DocumentImportService } from "./service.js";

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface DocumentListSyncLogger {
  info(bindings: Record<string, unknown>, message: string): void;
}

/** 每日全量对账判据（独立导出便于测试）：从未全量过、或距上次全量 ≥24h
 *  时返回 true——全量替换缓存顺带清掉远端已删除的文档。 */
export function shouldFullSync(lastFullAt: Date | null, now: Date): boolean {
  if (!lastFullAt) return true;
  return now.getTime() - lastFullAt.getTime() >= FULL_SYNC_INTERVAL_MS;
}

/**
 * 文档列举后台增量同步：每 15 分钟遍历列举缓存行做 delta 合并（面板打开
 * 无需等待全量拉取即可拿到新鲜列表）；距上次全量 ≥24h 自动做一次全量对账
 * 清掉远端已删除的文档。只处理已有缓存行的连接（用户用过列举面板才会建行），
 * 连接已断开等预期失败静默跳过，不影响下一轮。
 */
export class DocumentListSyncWorker {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly service: DocumentImportService,
    private readonly logger: DocumentListSyncLogger,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const rows = this.db
        .select({
          provider: documentImportListCache.provider,
          connectionName: documentImportListCache.connectionName,
          lastFullAt: documentImportListCache.lastFullAt,
        })
        .from(documentImportListCache)
        .all();
      const now = new Date();
      for (const row of rows) {
        const mode = shouldFullSync(row.lastFullAt ?? null, now) ? "full" : "delta";
        try {
          await this.service.listAllDocuments(
            row.provider as ExternalDocumentProvider,
            row.connectionName || undefined,
            mode,
          );
        } catch (error) {
          // 连接断开/token 失效是常态（缓存行不随断开删除），静默记录即可。
          this.logger.info(
            { provider: row.provider, mode, error: error instanceof Error ? error.message : String(error) },
            "document list background sync skipped",
          );
        }
      }
    } catch (error) {
      // 顶部缓存 SELECT 等在逐行 catch 之外；tick 由 void 调用，漏接即未处理
      // 拒绝、直接杀死网关进程（2026-10-17 排障）。记日志照常进入下一轮。
      this.logger.info(
        { error: error instanceof Error ? error.message : String(error) },
        "document list sync round failed",
      );
    } finally {
      this.ticking = false;
    }
  }
}
