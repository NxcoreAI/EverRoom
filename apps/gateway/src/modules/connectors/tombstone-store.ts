import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { connectorTombstones } from "../../infrastructure/database/schema.js";

/**
 * 本地「已断开」记录。
 *
 * oo 是连接的事实源；SaaS 模式下客户端没有 admin 权限删远端凭据，
 * 所以断开只删本地可见性。查询/执行层按墓碑过滤，避免用户断开后
 * Agent 还能查到该账号。
 */
export interface ConnectorTombstoneStore {
  has(service: string, connectionName: string): boolean;
  add(service: string, connectionName: string): void;
  remove(service: string, connectionName: string): void;
  list(): Array<{ service: string; connectionName: string }>;
}

export function createConnectorTombstoneStore(
  db: GatewayDatabase,
  ownerId: string,
): ConnectorTombstoneStore {
  return {
    has(service, connectionName) {
      const row = db
        .select({ id: connectorTombstones.id })
        .from(connectorTombstones)
        .where(
          and(
            eq(connectorTombstones.ownerId, ownerId),
            eq(connectorTombstones.service, service),
            eq(connectorTombstones.connectionName, connectionName),
          ),
        )
        .get();
      return Boolean(row);
    },
    add(service, connectionName) {
      db.insert(connectorTombstones)
        .values({ id: randomUUID(), ownerId, service, connectionName })
        .onConflictDoNothing()
        .run();
    },
    remove(service, connectionName) {
      db.delete(connectorTombstones)
        .where(
          and(
            eq(connectorTombstones.ownerId, ownerId),
            eq(connectorTombstones.service, service),
            eq(connectorTombstones.connectionName, connectionName),
          ),
        )
        .run();
    },
    list() {
      return db
        .select({ service: connectorTombstones.service, connectionName: connectorTombstones.connectionName })
        .from(connectorTombstones)
        .where(eq(connectorTombstones.ownerId, ownerId))
        .all();
    },
  };
}
