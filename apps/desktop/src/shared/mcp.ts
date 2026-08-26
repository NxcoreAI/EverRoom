export interface McpSecretState {
  configured: boolean
}

export type McpSecretMutation =
  | { operation: 'keep' }
  | { operation: 'set'; value: string }
  | { operation: 'delete' }

export interface McpServerDefinition {
  command?: string
  args?: string[]
  env?: Record<string, McpSecretState>
  cwd?: string
  url?: string
  headers?: Record<string, McpSecretState>
  bearerTokenEnv?: string
  lifecycle?: 'lazy' | 'eager' | 'keep-alive' | 'lazy-keep-alive'
  disabled?: boolean
  [key: string]: unknown
}

export interface McpServerMutation extends Omit<McpServerDefinition, 'env' | 'headers'> {
  previousName?: string
  env?: Record<string, McpSecretMutation>
  headers?: Record<string, McpSecretMutation>
}

export interface McpServersSnapshot {
  configPath: string
  servers: Record<string, McpServerDefinition>
}

export type McpServersMutation = Record<string, McpServerMutation>
