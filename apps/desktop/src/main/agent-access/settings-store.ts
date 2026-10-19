import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GatewaySupervisor } from '../gateway/gateway-supervisor'

/**
 * 外部 Agent 访问的桌面侧设置（独立于网关库：portProvider 在网关 spawn 前求值，
 * 网关还没起，读不了 runtime config）。固定端口让安装到外部工具的 MCP 配置
 * 在网关重启后仍然有效（PRD 7.1 安装一次持续可用）。
 */

export interface AgentAccessSettings {
  /** null = 随机端口（默认，外部工具配置会随重启失效）。 */
  fixedPort: number | null
}

const DEFAULTS: AgentAccessSettings = { fixedPort: null }
const PORT_MIN = 1024
const PORT_MAX = 65_535

export function isValidFixedPort(value: number): boolean {
  return Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX
}

export class AgentAccessSettingsStore {
  private readonly filePath: string

  constructor(private readonly dataDirectory: string) {
    this.filePath = join(dataDirectory, 'agent-access-settings.json')
  }

  read(): AgentAccessSettings {
    try {
      if (!existsSync(this.filePath)) return { ...DEFAULTS }
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<AgentAccessSettings>
      const fixedPort = typeof parsed.fixedPort === 'number' && isValidFixedPort(parsed.fixedPort)
        ? parsed.fixedPort
        : null
      return { fixedPort }
    } catch {
      // 损坏文件按默认值处理并会被下一次 write 覆盖；不让设置问题阻断网关启动。
      return { ...DEFAULTS }
    }
  }

  write(next: AgentAccessSettings): void {
    mkdirSync(this.dataDirectory, { recursive: true })
    writeFileSync(this.filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }

  /** supervisor 的 portProvider：同步读文件（每次网关启动求值一次）。 */
  portProvider(): number | null {
    return this.read().fixedPort
  }

  /** 当前网关实际端口（渲染层展示用；固定端口未生效前与设置值不同）。 */
  currentGatewayPort(supervisor: GatewaySupervisor): number | null {
    try {
      const baseUrl = supervisor.getConnection().baseUrl
      const port = Number(new URL(baseUrl).port)
      return Number.isFinite(port) && port > 0 ? port : null
    } catch {
      return null
    }
  }

  /** 端口可用性预检：bind 成功即视为空闲（不发送任何数据）。 */
  static async isPortFree(port: number): Promise<boolean> {
    const net = await import('node:net')
    return await new Promise((resolve) => {
      const probe = net.createServer()
      probe.once('error', () => resolve(false))
      probe.once('listening', () => {
        probe.close(() => resolve(true))
      })
      probe.listen(port, '127.0.0.1')
    })
  }
}
