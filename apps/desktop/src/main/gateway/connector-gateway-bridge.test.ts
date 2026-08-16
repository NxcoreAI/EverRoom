import { describe, expect, it } from 'vitest'
import { ConnectorGatewayBridge } from './connector-gateway-bridge'
import type { GatewaySupervisor } from './gateway-supervisor'

function bridge(): ConnectorGatewayBridge {
  return new ConnectorGatewayBridge({} as GatewaySupervisor)
}

describe('ConnectorGatewayBridge input boundary', () => {
  it('rejects unsupported providers before issuing a request', () => {
    expect(() => bridge().registerConnection({
      provider: 'imap' as 'gmail',
      nangoConfigKey: 'mail',
      nangoConnectionId: 'connection-1',
    })).toThrow('不支持的连接提供方')
  })

  it('rejects unsupported authorization providers before issuing a request', async () => {
    await expect(bridge().startAuthorization('imap' as 'gmail')).rejects.toThrow('不支持的连接提供方')
  })

  it('rejects unsafe path identifiers', () => {
    expect(() => bridge().triggerSync('../scope', 'incremental')).toThrow('无效的连接器标识')
  })

  it('rejects unknown synchronization modes', () => {
    expect(() => bridge().triggerSync('scope-1', 'unknown' as 'full')).toThrow('无效的同步模式')
  })

  it('rejects unknown fault injection points', () => {
    expect(() => bridge().armFault('before_commit')).toThrow('无效的故障注入点')
  })
})
