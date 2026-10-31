import type { ConnectorConnection, ConnectorProvider } from "@nxcore/connector-contract";
import type { ConnectorActionRuntime } from "./query/types.js";

/** oo service → EverRoom provider（Google 系命名不同）。 */
const PROVIDER_OF_SERVICE: Record<string, ConnectorProvider> = {
  gmail: "gmail",
  outlook: "outlook",
  notion: "notion",
  googlecalendar: "google-calendar",
  googledrive: "google-docs",
  feishu: "feishu",
};

export function providerOfService(service: string): ConnectorProvider {
  return PROVIDER_OF_SERVICE[service] ?? service;
}

/** 本地可见的连接 id：service:connectionName（桌面 ID_PATTERN 允许冒号）。 */
export function connectionIdOf(service: string, connectionName: string): string {
  return `${service}:${connectionName}`;
}

export function parseConnectionId(id: string): { service: string; connectionName: string } | null {
  const separator = id.indexOf(":");
  if (separator <= 0 || separator === id.length - 1) return null;
  const service = id.slice(0, separator);
  const connectionName = id.slice(separator + 1);
  if (!service || !connectionName) return null;
  return { service, connectionName };
}

export interface ConnectorDisconnectStore {
  has(service: string, connectionName: string): boolean;
  add(service: string, connectionName: string): void;
  remove(service: string, connectionName: string): void;
  list(): Array<{ service: string; connectionName: string }>;
}

/**
 * 连接目录：事实源是 oo，本地只叠加「已断开」墓碑。
 * 不再有 scope / run / 游标；同步时代的 connector_connections 表已删除。
 */
export class ConnectorConnectionCatalog {
  constructor(
    private readonly runtime: ConnectorActionRuntime,
    private readonly tombstones: ConnectorDisconnectStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<ConnectorConnection[]> {
    const connections = await this.runtime.listConnections();
    return connections
      .filter((connection) => !this.tombstones.has(connection.service, connection.connectionName))
      .map((connection) => this.toConnection(connection.service, connection.connectionName));
  }

  /**
   * 断开的连接（墓碑投影）：oo 凭据仍在但被本地关掉了。
   * 桌面据此区分「未开启」（有凭据但关着）和「未连接」（oo 根本没有凭据）。
   */
  listDisconnected(): Array<{ service: string; connectionName: string }> {
    return this.tombstones.list();
  }

  async get(id: string): Promise<ConnectorConnection | null> {
    const parsed = parseConnectionId(id);
    if (!parsed) return null;
    const connections = await this.list();
    return connections.find((connection) => connection.id === id) ?? null;
  }

  isDisconnected(service: string, connectionName: string): boolean {
    return this.tombstones.has(service, connectionName);
  }

  /** 断开：本地墓碑。oo 远端凭据保留（SaaS 模式客户端没有 admin 权限）。 */
  disconnect(id: string): boolean {
    const parsed = parseConnectionId(id);
    if (!parsed) return false;
    this.tombstones.add(parsed.service, parsed.connectionName);
    return true;
  }

  /** 重新开启：移除本地墓碑（oo 凭据一直在），连接回到可见/可查询状态。 */
  reconnect(id: string): boolean {
    const parsed = parseConnectionId(id);
    if (!parsed) return false;
    this.tombstones.remove(parsed.service, parsed.connectionName);
    return true;
  }

  private toConnection(service: string, connectionName: string): ConnectorConnection {
    const timestamp = this.now().toISOString();
    return {
      id: connectionIdOf(service, connectionName),
      provider: providerOfService(service),
      service,
      connectionName,
      accountIdentityHash: null,
      status: "active",
      filters: {},
      createdAt: timestamp,
      updatedAt: timestamp,
      authMethod: "nango-oauth",
    };
  }
}
