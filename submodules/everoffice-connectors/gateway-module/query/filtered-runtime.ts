import type { ConnectorActionRuntime } from "./types.js";

/** 已断开连接的过滤接口（宿主注入连接墓碑）。 */
export interface ConnectorDisconnectStore {
  has(service: string, connectionName: string): boolean;
}

/**
 * 在 Query 层前过滤掉用户已断开的连接。
 * listConnections 与 runAction 都走同一判据，避免“列表里消失但还能读”。
 */
export class FilteredConnectorRuntime implements ConnectorActionRuntime {
  constructor(
    private readonly runtime: ConnectorActionRuntime,
    private readonly disconnected: ConnectorDisconnectStore,
  ) {}

  async listConnections(): Promise<Array<{ service: string; connectionName: string; status?: string }>> {
    const connections = await this.runtime.listConnections();
    return connections.filter(
      (connection) => !this.disconnected.has(connection.service, connection.connectionName),
    );
  }

  async runAction(
    service: string,
    action: string,
    input: Record<string, unknown>,
    options: { connectionName: string; signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.disconnected.has(service, options.connectionName)) {
      throw new Error(`connection_disconnected: ${service}/${options.connectionName}`);
    }
    return this.runtime.runAction(service, action, input, options);
  }
}
