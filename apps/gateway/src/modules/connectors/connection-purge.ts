import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import type { ConnectorDocumentStore } from "@nxcore/connectors-module/document-store.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  connectorCalendarEvents,
  connectorEmails,
  ingestEvents,
} from "../../infrastructure/database/schema.js";
import type { MemoryService } from "../memory/service.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { SourceKind } from "../knowledge/entity-registry.js";

export interface ConnectorPurgeCascadeDeps {
  db: GatewayDatabase;
  memory: MemoryService;
  knowledge: KnowledgeService;
  documentStore: ConnectorDocumentStore | null;
  ownerId: string;
  log: { info(bindings: unknown, msg: string): void; warn(bindings: unknown, msg: string): void };
}

export interface ConnectorPurgeCascadeSummary {
  mailRows: number;
  calendarRows: number;
  memoryDeleted: number;
  ledgerRows: number;
}

/**
 * 连接删除级联（routes onPurge 注入）：清理该连接在 gateway.sqlite 的全部
 * 下游沉淀——域表行、记忆文档（callerRef = 域行 id / connector ref）、
 * ingest 台账、knowledge Room/wiki 归属、document-store 落盘文件。
 * connectors.sqlite 由调用后的 repository.purgeConnection 收尾。
 *
 * 幂等：各步均可安全重试（重复删除为 no-op）；失败抛错时连接保留，
 * 路由 500，用户重试即可。domain 行先收集 id 再删除，记忆删除按收集的
 * id 集合 + connector ref 前缀一次扫描完成（单 ref 逐条是 O(N×M)）。
 *
 * LIKE 前缀安全前提：connectionId 为 repository 铸造的 UUID、provider 为
 * 注册表词表，均不含 % / _ 通配符。
 */
export async function purgeConnectorConnectionCascade(
  deps: ConnectorPurgeCascadeDeps,
  connection: { id: string; provider: string },
): Promise<ConnectorPurgeCascadeSummary> {
  const { db, memory, knowledge, documentStore, ownerId, log } = deps;

  const mailRows = db.select({ id: connectorEmails.id }).from(connectorEmails)
    .where(and(eq(connectorEmails.ownerId, ownerId), eq(connectorEmails.connectionName, connection.id)))
    .all();
  const calendarRows = db.select({ id: connectorCalendarEvents.id }).from(connectorCalendarEvents)
    .where(and(eq(connectorCalendarEvents.ownerId, ownerId), eq(connectorCalendarEvents.connectionName, connection.id)))
    .all();
  const domainIds = [...mailRows, ...calendarRows].map((row) => row.id);
  const refPrefix = `connector:${connection.provider}:${connection.id}:`;

  // 记忆文档：mail/calendar 的 callerRef = 域行 id（M4），document 与存量
  // 遗留行为 connector ref——前缀一并覆盖。级联清 L0 会话/分块/派生 L1。
  const memoryDeleted = await memory.deleteDocumentsByCallerRefs({ refs: domainIds, prefix: refPrefix });

  // 台账：命中的活跃行软删（与 cleanupSource 同语义：保留历史、旧 hash 不再幂等命中），
  // 并把 (sourceKind, sourceId) 批量交 knowledge 做实体/关系/wiki 清理。
  const ledgerRows = db.select({ sourceKind: ingestEvents.sourceKind, sourceId: ingestEvents.sourceId }).from(ingestEvents)
    .where(and(
      isNull(ingestEvents.deletedAt),
      domainIds.length > 0
        ? or(inArray(ingestEvents.sourceId, domainIds), like(ingestEvents.sourceId, refPrefix + "%"))
        : like(ingestEvents.sourceId, refPrefix + "%"),
    ))
    .all();
  if (ledgerRows.length > 0) {
    const now = new Date();
    db.update(ingestEvents).set({ deletedAt: now, updatedAt: now }).where(and(
      isNull(ingestEvents.deletedAt),
      inArray(ingestEvents.sourceId, ledgerRows.map((row) => row.sourceId)),
    )).run();
    knowledge.requestSourceCleanups(ledgerRows as Array<{ sourceKind: SourceKind; sourceId: string }>);
  }

  db.delete(connectorEmails)
    .where(and(eq(connectorEmails.ownerId, ownerId), eq(connectorEmails.connectionName, connection.id)))
    .run();
  db.delete(connectorCalendarEvents)
    .where(and(eq(connectorCalendarEvents.ownerId, ownerId), eq(connectorCalendarEvents.connectionName, connection.id)))
    .run();
  if (documentStore) await documentStore.purge(connection.provider, connection.id);

  const summary: ConnectorPurgeCascadeSummary = {
    mailRows: mailRows.length,
    calendarRows: calendarRows.length,
    memoryDeleted: memoryDeleted.length,
    ledgerRows: ledgerRows.length,
  };
  log.info({ module: "connector-purge-cascade", connectionId: connection.id, ...summary }, "connector connection downstream cascade purged");
  return summary;
}
