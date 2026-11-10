export interface NormalizedMigrationAttachment {
  stableKey: string
  name: string
  mimeType?: string
  filePath?: string
  missing?: boolean
}

export interface NormalizedMigrationThread {
  stableKey: string
  agentId?: string
  externalSessionId: string
  title: string
  messages: Array<{
    stableKey: string
    role: 'user' | 'assistant'
    content: string
    occurredAt: string
    attachments?: NormalizedMigrationAttachment[]
  }>
}

/** 上传网关的线形态：附件已上传（fileId 落位）或标记 missing。 */
export interface MigrationAttachmentRef {
  sourceKey: string
  name: string
  mimeType?: string
  fileId?: string
  missing?: boolean
}

export interface MigrationThreadUpload {
  stableKey: string
  agentId?: string
  externalSessionId: string
  title: string
  messages: Array<{
    stableKey: string
    role: 'user' | 'assistant'
    content: string
    occurredAt: string
    attachments?: MigrationAttachmentRef[]
  }>
}
