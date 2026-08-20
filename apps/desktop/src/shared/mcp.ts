/** 设置页 MCP 管理（pi-mcp-adapter 服务器定义子集 + 透传高级字段）。 */

export interface McpServerDefinition {
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  bearerTokenEnv?: string
  lifecycle?: 'lazy' | 'eager' | 'keep-alive' | 'lazy-keep-alive'
  disabled?: boolean
  [key: string]: unknown
}

export interface McpServersSnapshot {
  configPath: string
  servers: Record<string, McpServerDefinition>
}
