import type { Readable } from 'node:stream'

import type { DataSourceKind } from '../../shared/sources'

export type ConnectorKind = DataSourceKind
export type ConnectorCapability = 'pull' | 'incremental' | 'watch'

export interface ConnectorConnection<TConfig = unknown> {
  id: string
  kind: ConnectorKind
  name: string
  config: TConfig
}

export interface ConnectorItem {
  remoteId: string
  title: string
  uri: string
  path: string
  extension: string
  byteSize: number
  modifiedAt: string
  openContent(): Readable
}

export interface ConnectorScanResult {
  items: ConnectorItem[]
  failed: number
}

export interface ConnectorSubscription {
  close(): void
}

export interface Connector<TConfig = unknown> {
  readonly kind: ConnectorKind
  readonly capabilities: readonly ConnectorCapability[]
  getConnectionKey(config: TConfig): string
  scan(connection: ConnectorConnection<TConfig>): Promise<ConnectorScanResult>
  watch?(
    connection: ConnectorConnection<TConfig>,
    onChange: () => void,
    onError?: () => void,
  ): ConnectorSubscription | null
  resolveLocalPath?(
    connection: ConnectorConnection<TConfig>,
    itemPath: string,
  ): string
}
