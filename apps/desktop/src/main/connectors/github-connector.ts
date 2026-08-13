import { Readable } from 'node:stream'

import type {
  Connector,
  ConnectorConnection,
  ConnectorItem,
  ConnectorScanResult,
} from './types'

export interface GitHubConfig {
  repository: string
  branch?: string
  tokenCredentialKey?: string
  syncIssues?: boolean
}

interface GitHubResponse<T> {
  data: T
  headers: Headers
}

interface Repository {
  default_branch: string
  pushed_at: string | null
}

interface TreeEntry {
  path: string
  mode: string
  type: string
  sha: string
  size?: number
}

interface Tree {
  tree: TreeEntry[]
  truncated: boolean
}

interface RefCommit {
  commit: { committer: { date: string | null } }
}

interface Issue {
  number: number
  title: string
  body: string | null
  html_url: string
  updated_at: string
  pull_request?: unknown
}

interface Comment {
  user: { login: string } | null
  body: string | null
  created_at: string
}

const MAX_FILE_SIZE = 5 * 1024 * 1024
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.json',
  '.jsx', '.md', '.mdx', '.py', '.rb', '.rs', '.sh', '.sql', '.swift', '.toml', '.ts',
  '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml',
])

export class GitHubConnector implements Connector<GitHubConfig> {
  readonly kind = 'github' as const
  readonly capabilities = ['pull', 'incremental'] as const

  constructor(private readonly resolveToken: (key: string | undefined) => Promise<string | undefined>) {}

  getConnectionKey(config: GitHubConfig): string {
    const repository = this.normalizeRepository(config.repository)
    return `${repository}:${config.branch?.trim() || 'default'}:${config.syncIssues !== false ? 'issues' : 'code'}`
  }

  async scan(connection: ConnectorConnection<GitHubConfig>): Promise<ConnectorScanResult> {
    const config = connection.config
    const repository = this.normalizeRepository(config.repository)
    const token = await this.resolveToken(config.tokenCredentialKey)
    const headers = this.headers(token)
    const repo = await this.request<Repository>(`/repos/${repository}`, headers)
    const branch = config.branch?.trim() || repo.data.default_branch
    const ref = await this.request<RefCommit>(`/repos/${repository}/commits/${encodeURIComponent(branch)}`, headers)
    const modifiedAt = ref.data.commit.committer.date || repo.data.pushed_at || new Date().toISOString()
    const tree = await this.request<Tree>(`/repos/${repository}/git/trees/${encodeURIComponent(branch)}?recursive=1`, headers)
    if (tree.data.truncated) throw new Error('GitHub 仓库目录过大，无法在一次同步中完整读取。')

    const items: ConnectorItem[] = []
    let failed = 0
    for (const entry of tree.data.tree) {
      if (entry.type !== 'blob' || !this.isTextFile(entry.path) || (entry.size ?? 0) > MAX_FILE_SIZE) continue
      try {
        const blob = await this.request<{ content: string; encoding: string }>(`/repos/${repository}/git/blobs/${entry.sha}`, headers)
        const content = this.decodeBlob(blob.data.content, blob.data.encoding)
        items.push(this.item(
          `repo:blob:${entry.path}`,
          entry.path.split('/').at(-1) || entry.path,
          `https://github.com/${repository}/blob/${encodeURIComponent(branch)}/${entry.path}`,
          entry.path,
          this.extension(entry.path),
          content,
          entry.size ?? Buffer.byteLength(content),
          modifiedAt,
        ))
      } catch {
        failed += 1
      }
    }

    if (config.syncIssues !== false) {
      const issues = await this.listAll<Issue>(`/repos/${repository}/issues?state=all&per_page=100`, headers)
      for (const issue of issues) {
        if (issue.pull_request) continue
        try {
          const comments = await this.listAll<Comment>(`/repos/${repository}/issues/${issue.number}/comments?per_page=100`, headers)
          const content = [`# ${issue.title}`, '', issue.body || '', ...comments.map((comment) => `\n## ${comment.user?.login || '评论'} · ${comment.created_at}\n\n${comment.body || ''}`)].join('\n').trim() + '\n'
          items.push(this.item(`repo:issue:${issue.number}`, issue.title, issue.html_url, `issues/${issue.number}.md`, '.md', content, Buffer.byteLength(content), issue.updated_at))
        } catch {
          failed += 1
        }
      }
    }
    return { items, failed }
  }

  private item(remoteId: string, title: string, uri: string, path: string, extension: string, content: string, byteSize: number, modifiedAt: string): ConnectorItem {
    return { remoteId, title, uri, path, extension, byteSize, modifiedAt, openContent: () => Readable.from([content]) }
  }

  private headers(token: string | undefined): HeadersInit {
    return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NexCore-CE', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  }

  private async request<T>(path: string, headers: HeadersInit): Promise<GitHubResponse<T>> {
    const response = await fetch(`https://api.github.com${path}`, { headers })
    if (!response.ok) {
      if (response.status === 401) throw new Error('GitHub 凭证无效或已过期。')
      if (response.status === 403) throw new Error('GitHub 请求被拒绝，可能触发了速率限制。')
      if (response.status === 404) throw new Error('GitHub 仓库、分支或对象不存在。')
      throw new Error(`GitHub API 请求失败（${response.status}）。`)
    }
    return { data: await response.json() as T, headers: response.headers }
  }

  private async listAll<T>(path: string, headers: HeadersInit): Promise<T[]> {
    const separator = path.includes('?') ? '&' : '?'
    const all: T[] = []
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.request<T[]>(`${path}${separator}page=${page}`, headers)
      all.push(...response.data)
      if (response.data.length < 100) return all
    }
    throw new Error('GitHub 返回数据超过分页上限。')
  }

  private decodeBlob(content: string, encoding: string): string {
    if (encoding !== 'base64') throw new Error('GitHub 返回了不支持的内容编码。')
    return Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8')
  }

  private isTextFile(path: string): boolean {
    const dot = path.lastIndexOf('.')
    return dot > -1 && TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase())
  }

  private extension(path: string): string {
    const dot = path.lastIndexOf('.')
    return dot > -1 ? path.slice(dot).toLowerCase() : '.txt'
  }

  private normalizeRepository(value: string): string {
    const repository = value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '')
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error('GitHub 仓库格式应为 owner/repository。')
    return repository
  }
}
