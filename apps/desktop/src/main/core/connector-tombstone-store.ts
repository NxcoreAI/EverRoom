import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 连接器删除墓碑：用户主动 purge 的连接按 EverRoom userId + provider 记录，
 * 供 reconcile 对账跳过——远端 oo 租户凭据仍在（删除不上行），不记墓碑的话
 * 重登录会被对账逻辑自动补注册复活。oo 租户按登录账号派生，墓碑同维度隔离，
 * 换账号登录后旧墓碑自然不生效。
 */
export class ConnectorTombstoneStore {
  private cache: Record<string, string[]> | null = null

  constructor(private readonly file: string) {}

  private async read(): Promise<Record<string, string[]>> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string[]>
      this.cache = parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  private async persist(state: Record<string, string[]>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(state, null, 2), 'utf8')
    this.cache = state
  }

  async add(userId: string, provider: string): Promise<void> {
    const state = await this.read()
    const current = state[userId] ?? []
    if (current.includes(provider)) return
    await this.persist({ ...state, [userId]: [...current, provider] })
  }

  async remove(userId: string, provider: string): Promise<void> {
    const state = await this.read()
    const current = state[userId]
    if (!current?.includes(provider)) return
    const next = current.filter((item) => item !== provider)
    const nextState = { ...state }
    if (next.length > 0) nextState[userId] = next
    else delete nextState[userId]
    await this.persist(nextState)
  }

  async has(userId: string, provider: string): Promise<boolean> {
    const state = await this.read()
    return (state[userId] ?? []).includes(provider)
  }
}

export function createConnectorTombstoneStore(dataDirectory: string): ConnectorTombstoneStore {
  return new ConnectorTombstoneStore(join(dataDirectory, 'connector-tombstones.json'))
}
