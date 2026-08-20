export type OpenConnectorGatewayState = 'starting' | 'ready' | 'unreachable' | 'unauthorized'
export type OoCliState = 'checking' | 'ready' | 'missing' | 'error'

export interface OpenConnectorStatus {
  baseUrl: string
  managed: boolean
  gatewayPid: number | null
  gatewayVersion: string | null
  gatewayState: OpenConnectorGatewayState
  gatewayMessage: string | null
  runtimeTokenConfigured: boolean
  cliState: OoCliState
  cliVersion: string | null
  cliPath: string
  cliMessage: string | null
}

export interface OpenConnectorActionSummary {
  service: string
  name: string
  description: string
  authenticated: boolean
}

export interface OpenConnectorActionSchema {
  service: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
}

export interface OpenConnectorConnectionSummary {
  service: string
  connectionName: string | null
  displayName: string
  accountLabel: string
  authType: string | null
  status: string
  scopes: string[]
  isDefault: boolean
}

export type OpenConnectorCommandRequest =
  | { kind: 'search'; query: string }
  | { kind: 'schema'; actionId: string; refresh?: boolean }
  | {
      kind: 'run'
      service: string
      action: string
      input: Record<string, unknown>
      connectionName?: string
      dryRun?: boolean
    }
  | { kind: 'apps'; service?: string }

export interface OpenConnectorCommandResult<T = unknown> {
  requestId: string
  kind: OpenConnectorCommandRequest['kind']
  command: string
  startedAt: string
  finishedAt: string
  durationMs: number
  exitCode: number
  data: T
  stderr: string
}

export type OpenConnectorCommandEvent =
  | {
      type: 'started'
      requestId: string
      kind: OpenConnectorCommandRequest['kind']
      command: string
      timestamp: string
    }
  | {
      type: 'output'
      requestId: string
      stream: 'stdout' | 'stderr'
      text: string
      timestamp: string
    }
  | {
      type: 'finished'
      requestId: string
      exitCode: number
      durationMs: number
      timestamp: string
    }

export interface OpenConnectorExecutionInput {
  requestId: string
  command: OpenConnectorCommandRequest
}
