import { Readable } from 'node:stream'

import { createLoggedHttpClient } from '../network/http-client'
import type { Connector, ConnectorConnection, ConnectorItem, ConnectorScanResult } from './types'

export interface NotionConfig { pageIds: string[]; tokenCredentialKey?: string; token?: string }
const http = createLoggedHttpClient('notion', { baseURL: 'https://api.notion.com', timeout: 20_000 })
type RichText = { plain_text?: string; href?: string | null }
type Block = { type?: string; object?: string; has_children?: boolean; [key: string]: unknown }
function pageId(value: string): string {
  const match = value.match(/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{32})/i)
  if (!match) throw new Error(`Notion 页面 ID 无效：${value}`)
  return match[1].replace(/-/g, '')
}
function text(items: RichText[] = []): string { return items.map((item) => item.href ? `[${item.plain_text ?? ''}](${item.href})` : item.plain_text ?? '').join('') }
function blockMarkdown(block: Block): string {
  const data = block[block.type ?? ''] as { rich_text?: RichText[]; language?: string; caption?: RichText[]; checked?: boolean } | undefined
  const value = text(data?.rich_text)
  switch (block.type) {
    case 'heading_1': return `# ${value}`
    case 'heading_2': return `## ${value}`
    case 'heading_3': return `### ${value}`
    case 'bulleted_list_item': return `- ${value}`
    case 'numbered_list_item': return `1. ${value}`
    case 'to_do': return `- [${data?.checked ? 'x' : ' '}] ${value}`
    case 'quote': return `> ${value}`
    case 'callout': return `> ${value}`
    case 'code': return `\`\`\`${data?.language ?? ''}\n${value}\n\`\`\``
    case 'divider': return '---'
    case 'image': return value ? `![${value}](${value})` : ''
    default: return value
  }
}

export class NotionConnector implements Connector<NotionConfig> {
  readonly kind = 'notion' as const
  readonly capabilities = ['pull'] as const
  constructor(private readonly resolveToken: (key: string | undefined) => Promise<string | undefined>) {}
  getConnectionKey(config: NotionConfig): string { return config.pageIds.map(pageId).sort().join(',') }
  async scan(connection: ConnectorConnection<NotionConfig>): Promise<ConnectorScanResult> {
    const token = connection.config.token ?? await this.resolveToken(connection.config.tokenCredentialKey)
    if (!token) throw new Error('Notion integration token 不存在或已过期。')
    const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
    const items: ConnectorItem[] = []
    let failed = 0
    for (const rawId of connection.config.pageIds) {
      try {
        const id = pageId(rawId)
        const page = await http.get<{ id: string; url?: string; properties?: Record<string, { type?: string; title?: RichText[]; rich_text?: RichText[] }> }>(`/v1/pages/${id}`, { headers })
        const titleProperty = Object.values(page.data.properties ?? {}).find((property) => property.type === 'title')
        const title = text(titleProperty?.title ?? titleProperty?.rich_text) || id
        const blocks: Block[] = []
        let cursor: string | undefined
        do {
          const response = await http.get<{ results?: Block[]; next_cursor?: string | null }>(`/v1/blocks/${id}/children`, { headers, params: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } })
          blocks.push(...(response.data.results ?? [])); cursor = response.data.next_cursor ?? undefined
        } while (cursor)
        const content = `# ${title}\n\n${blocks.map(blockMarkdown).filter(Boolean).join('\n\n')}\n`
        items.push({ remoteId: id, title, uri: page.data.url ?? `https://www.notion.so/${id}`, path: `${title.replace(/[\\/:*?"<>|]/g, '_')}.md`, extension: '.md', byteSize: Buffer.byteLength(content), modifiedAt: new Date().toISOString(), openContent: () => Readable.from([content]) })
      } catch { failed += 1 }
    }
    return { items, failed }
  }
}
