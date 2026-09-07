import { describe, expect, it } from 'vitest'
import { createOpenConnectorPiTools, type OoHttpRunner } from './open-connector-tools.js'
import type { OpenConnectorCliConfig } from './host-types.js'

/**
 * 回归锁：runOoHttp 返回运行时封套 { success, data }，连接条目的名字段是
 * alias。connectorApps 解析漏掉封套/alias 时，connector_run 在有活跃连接的
 * 情况下也会误报 "no active connection"（2026-09 连接器统一回归发现）。
 */

const config: OpenConnectorCliConfig = {
  executable: 'oo',
  baseUrl: 'http://127.0.0.1:3999',
  runtimeToken: 'test-token',
  configDirectory: '/tmp/oo-test/config',
  dataDirectory: '/tmp/oo-test/data',
}

type HttpCall = Parameters<OoHttpRunner>[1]

function fakeRunner(options: { appsData?: unknown[] }): {
  calls: HttpCall[]
  runner: OoHttpRunner
} {
  const calls: HttpCall[] = []
  const runner: OoHttpRunner = async (_config, call) => {
    calls.push(call)
    if (call.kind === 'apps') {
      return { success: true, message: 'OK', data: options.appsData ?? [], meta: {} }
    }
    if (call.kind === 'schema') {
      return {
        success: true,
        message: 'OK',
        data: { id: `${call.service}.${call.action}`, input: { type: 'object' } },
        meta: {},
      }
    }
    if (call.kind === 'run') {
      return { success: true, message: 'OK', data: { ok: true }, meta: {} }
    }
    return { success: true, message: 'OK', data: [], meta: {} }
  }
  return { calls, runner }
}

function runTool() {
  const { calls, runner } = fakeRunner({
    appsData: [
      { id: 'c1', service: 'feishu', status: 'active', alias: 'vyi-tech', isDefault: true },
    ],
  })
  const tools = createOpenConnectorPiTools(config, runner)
  const run = tools.find((tool) => tool.name === 'connector_run')
  if (!run) throw new Error('connector_run tool missing')
  return { run, calls }
}

describe('connector_run connection resolution over HTTP envelope', () => {
  it('resolves connectionName from envelope data + alias', async () => {
    const { run, calls } = runTool()
    const result = await run.execute(
      { runId: 'r1', sessionId: 's1', prompt: 'fetch a feishu doc' } as never,
      { service: 'feishu', name: 'fetch_document', input: { documentId: 'tokA' } },
      undefined,
    )
    expect(result).toBeTruthy()
    const runCall = calls.find((call) => call.kind === 'run')
    expect(runCall).toMatchObject({ service: 'feishu', action: 'fetch_document', connectionName: 'vyi-tech' })
  })

  it('skips disconnected apps when resolving', async () => {
    const { calls, runner } = fakeRunner({
      appsData: [{ id: 'c2', service: 'feishu', status: 'disconnected', alias: 'old', isDefault: false }],
    })
    const tools = createOpenConnectorPiTools(config, runner)
    const run = tools.find((tool) => tool.name === 'connector_run')
    if (!run) throw new Error('connector_run tool missing')
    await expect(
      run.execute(
        { runId: 'r2', sessionId: 's2', prompt: 'fetch a feishu doc' } as never,
        { service: 'feishu', name: 'fetch_document', input: { documentId: 'tokA' } },
        undefined,
      ),
    ).rejects.toThrow(/no active connection/i)
    expect(calls.find((call) => call.kind === 'run')).toBeUndefined()
  })
})
