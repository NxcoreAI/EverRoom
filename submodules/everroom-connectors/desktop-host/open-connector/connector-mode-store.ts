import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 连接层模式（P2-4 / D1 决策）：全局单开关，默认 SaaS。
 *
 * saas  → gateway 的 OpenConnectorHttpClient 直连 EverRoomSass 转发层
 *         （{saasApi}/app/connectors），本地 supervisor 不拉起
 * local → 现状：OpenConnectorSupervisor 拉起本地实例
 *
 * 切换语义（C3）：连接不迁移，已有连接提示需重新授权。
 * 未登录 SaaS（D2）：要求登录，不自动回退本地。
 */
export type ConnectorLayerMode = 'saas' | 'local'

export interface ConnectorModeState {
  mode: ConnectorLayerMode
  /** 上次切换时间（切换后提示重授权用）。 */
  switchedAt: string | null
}

const DEFAULT_STATE: ConnectorModeState = { mode: 'saas', switchedAt: null }

export class ConnectorModeStore {
  private cache: ConnectorModeState | null = null

  constructor(private readonly file: string) {}

  async read(): Promise<ConnectorModeState> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as ConnectorModeState
      this.cache = { ...DEFAULT_STATE, ...parsed, mode: parsed.mode === 'local' ? 'local' : 'saas' }
    } catch {
      this.cache = { ...DEFAULT_STATE }
    }
    return this.cache
  }

  async write(mode: ConnectorLayerMode): Promise<ConnectorModeState> {
    const next: ConnectorModeState = { mode, switchedAt: new Date().toISOString() }
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(next, null, 2), 'utf8')
    this.cache = next
    return next
  }

  /** gateway env 工厂注入（按模式计算 NXCORE_CLI_CONNECTOR_*）。 */
  gatewayEnv(state: ConnectorModeState, saasApiBaseUrl: string): Record<string, string> {
    if (state.mode === 'local') return {}
    const base = saasApiBaseUrl.replace(/\/+$/, '')
    return {
      NXCORE_CLI_CONNECTOR_URL: `${base}/app/connectors`,
      NXCORE_CLI_CONNECTOR_MANAGED: 'false',
    }
  }
}

export function createConnectorModeStore(dataDirectory: string): ConnectorModeStore {
  return new ConnectorModeStore(join(dataDirectory, 'connector-mode.json'))
}

/** 与 saas-client 同源的默认 SaaS API 地址（避免初始化顺序依赖 saasClient 实例）。 */
export function defaultSaasApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NXCORE_SAAS_API_URL || 'http://192.168.1.99:4100/api/v1').replace(/\/+$/, '')
}
