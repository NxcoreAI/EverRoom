import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentAccessSettingsStore, isValidFixedPort } from './settings-store'

const dirs: string[] = []

function makeStore(): AgentAccessSettingsStore {
  const dir = mkdtempSync(join(tmpdir(), 'agent-access-settings-'))
  dirs.push(dir)
  return new AgentAccessSettingsStore(dir)
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('AgentAccessSettingsStore', () => {
  it('默认随机端口；roundtrip 保留合法固定端口', () => {
    const store = makeStore()
    expect(store.read()).toEqual({ fixedPort: null })
    store.write({ fixedPort: 8790 })
    expect(store.read()).toEqual({ fixedPort: 8790 })
    expect(store.portProvider()).toBe(8790)
  })

  it('非法端口与损坏文件都回退默认，不抛错', () => {
    const store = makeStore()
    expect(isValidFixedPort(80)).toBe(false)
    expect(isValidFixedPort(70_000)).toBe(false)
    expect(isValidFixedPort(8790)).toBe(true)
    store.write({ fixedPort: 8790 })
    writeFileSync(join(dirs[dirs.length - 1]!, 'agent-access-settings.json'), 'not-json', 'utf8')
    expect(store.read()).toEqual({ fixedPort: null })
  })

  it('isPortFree：空闲端口为真，被占用端口为假', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const address = blocker.address() as { port: number }
    try {
      expect(await AgentAccessSettingsStore.isPortFree(address.port)).toBe(false)
      expect(await AgentAccessSettingsStore.isPortFree(address.port + 1)).toBe(true)
    } finally {
      blocker.close()
    }
  })
})
