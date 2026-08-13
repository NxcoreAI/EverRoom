import type { Connector, ConnectorKind } from './types'

export class ConnectorRegistry {
  private readonly connectors = new Map<ConnectorKind, Connector<any>>()

  register(connector: Connector<any>): this {
    if (this.connectors.has(connector.kind)) {
      throw new Error(`Connector already registered: ${connector.kind}`)
    }
    this.connectors.set(connector.kind, connector)
    return this
  }

  get(kind: ConnectorKind): Connector<any> {
    const connector = this.connectors.get(kind)
    if (!connector) throw new Error(`不支持的数据源类型：${kind}`)
    return connector
  }
}
