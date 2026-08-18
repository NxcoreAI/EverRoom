export type OpenConnectorState = 'starting' | 'ready' | 'stopped' | 'error'

export interface OpenConnectorStatus {
  state: OpenConnectorState
  baseUrl: string | null
  managed: boolean
  pid: number | null
  message: string | null
}

export interface OpenConnectorConnectionSummary {
  service: string
  connectionName: string | null
  displayName: string
  accountId: string | null
  authType: string
  status: string
  scopes: string[]
  isDefault: boolean
}

