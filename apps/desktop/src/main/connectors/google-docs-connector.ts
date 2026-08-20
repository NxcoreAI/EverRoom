import { Readable } from 'node:stream'

import { createLoggedHttpClient } from '../network/http-client'
import type { Connector, ConnectorConnection, ConnectorItem, ConnectorScanResult } from './types'

export interface GoogleDocsConfig {
  documentIds: string[]
  tokenCredentialKey?: string
  token?: string
}

const http = createLoggedHttpClient('google-docs', { baseURL: 'https://docs.googleapis.com', timeout: 20_000 })

type DocsElement = { paragraph?: { elements?: Array<{ textRun?: { content?: string } }> }; sectionBreak?: unknown; table?: { tableRows?: Array<{ tableCells?: Array<{ content?: DocsElement[] }> }> } }

function idFromValue(value: string): string {
  const match = value.match(/\/document\/d\/([a-zA-Z0-9_-]+)/) ?? value.match(/^([a-zA-Z0-9_-]{10,})$/)
  if (!match) throw new Error(`Google Docs 文档 ID 无效：${value}`)
  return match[1]
}

function inline(text: string): string {
  return text.replace(/\u000b/g, '').replace(/\r?\n$/, '')
}

function toMarkdown(elements: DocsElement[] = []): string {
  const lines: string[] = []
  for (const element of elements) {
    if (element.paragraph) {
      const text = inline((element.paragraph.elements ?? []).map((item) => item.textRun?.content ?? '').join(''))
      if (text) lines.push(text)
    } else if (element.table) {
      const rows = element.table.tableRows ?? []
      for (const [index, row] of rows.entries()) {
        const cells = (row.tableCells ?? []).map((cell) => toMarkdown(cell.content).replace(/\n+/g, ' ').trim())
        lines.push(`| ${cells.join(' | ')} |`)
        if (index === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`)
      }
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export class GoogleDocsConnector implements Connector<GoogleDocsConfig> {
  readonly kind = 'google-docs' as const
  readonly capabilities = ['pull'] as const
  constructor(private readonly resolveToken: (key: string | undefined) => Promise<string | undefined>) {}
  getConnectionKey(config: GoogleDocsConfig): string { return config.documentIds.map(idFromValue).sort().join(',') }
  async scan(connection: ConnectorConnection<GoogleDocsConfig>): Promise<ConnectorScanResult> {
    const token = connection.config.token ?? await this.resolveToken(connection.config.tokenCredentialKey)
    if (!token) throw new Error('Google Docs access token 不存在或已过期。')
    const items: ConnectorItem[] = []
    let failed = 0
    for (const rawId of connection.config.documentIds) {
      try {
        const id = idFromValue(rawId)
        const response = await http.get<{ title?: string; revisionId?: string; body?: { content?: DocsElement[] } }>(`/v1/documents/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } })
        const title = response.data.title?.trim() || id
        const content = `# ${title}\n\n${toMarkdown(response.data.body?.content ?? [])}`
        items.push({ remoteId: id, title, uri: `https://docs.google.com/document/d/${id}/edit`, path: `${title.replace(/[\\/:*?"<>|]/g, '_')}.md`, extension: '.md', byteSize: Buffer.byteLength(content), modifiedAt: new Date().toISOString(), openContent: () => Readable.from([content]) })
      } catch { failed += 1 }
    }
    return { items, failed }
  }
}
