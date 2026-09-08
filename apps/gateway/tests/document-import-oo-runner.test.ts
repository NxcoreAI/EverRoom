import { describe, expect, it } from 'vitest'
import type { OpenConnectorCliConfig } from '../src/config.js'
import {
  ImportConnectorError,
  resolveImportConnectionName,
  runImportConnectorAction,
  type ImportActionRunner,
} from '../src/modules/documents/import/oo-runner.js'

const connectorConfig: OpenConnectorCliConfig = {
  executable: 'oo',
  baseUrl: 'http://127.0.0.1:3999',
  runtimeToken: 'test-token',
  configDirectory: '/tmp/nxcore-import-test/oo-config',
  dataDirectory: '/tmp/nxcore-import-test/oo-data',
}

type HttpCall = Parameters<NonNullable<Parameters<typeof runImportConnectorAction>[3]>>[1]

/** HTTP /v1/apps 真实封套形状：{success, data: [{alias, isDefault, status}]}。 */
const APPS_ENVELOPE = {
  success: true,
  message: 'OK',
  data: [
    { id: 'c1', service: 'feishu', status: 'active', alias: 'vyi-tech', isDefault: true },
  ],
  meta: {},
}

function fakeHttp(responses: {
  apps?: unknown
  run?: unknown
  runError?: Error
}): { calls: HttpCall[]; fn: (config: OpenConnectorCliConfig, call: HttpCall) => Promise<unknown> } {
  const calls: HttpCall[] = []
  const fn = async (_config: OpenConnectorCliConfig, call: HttpCall) => {
    calls.push(call)
    if (call.kind === 'apps') {
      if (responses.apps instanceof Error) throw responses.apps
      return responses.apps ?? APPS_ENVELOPE
    }
    if (call.kind === 'run') {
      if (responses.runError) throw responses.runError
      return responses.run ?? { success: true, message: 'OK', data: { document: { content: '# hi' } }, meta: {} }
    }
    throw new Error(`unexpected call kind: ${String(call.kind)}`)
  }
  return { calls, fn }
}

describe('import oo-runner (OpenConnector HTTP transport)', () => {
  it('resolves the connection from the HTTP apps envelope (alias + data)', async () => {
    const name = await resolveImportConnectionName(connectorConfig, 'feishu', undefined, undefined, fakeHttp({}).fn)
    expect(name).toBe('vyi-tech')
  })

  it('unwraps the run envelope and passes the resolved connectionName', async () => {
    const { calls, fn } = fakeHttp({})
    const result = await runImportConnectorAction(
      connectorConfig,
      { service: 'feishu', action: 'fetch_document', input: { documentId: 'tokA', format: 'markdown' } },
      undefined,
      fn,
    )
    expect(result).toEqual({ document: { content: '# hi' } })
    expect(calls[0]).toMatchObject({ kind: 'apps', service: 'feishu' })
    expect(calls[1]).toMatchObject({
      kind: 'run',
      service: 'feishu',
      action: 'fetch_document',
      connectionName: 'vyi-tech',
    })
  })

  it('falls back to the whole envelope when data is empty', async () => {
    const { fn } = fakeHttp({ run: { success: true, message: 'OK', data: {}, meta: {} } })
    const result = await runImportConnectorAction(
      connectorConfig,
      { service: 'feishu', action: 'get_document', input: { documentId: 'tokA' } },
      undefined,
      fn,
    )
    expect(result).toEqual({ success: true, message: 'OK', data: {}, meta: {} })
  })

  it('maps HTTP 401 to authentication_required', async () => {
    const error = Object.assign(new Error('token expired (HTTP 401)'), { status: 401 })
    await expect(
      runImportConnectorAction(
        connectorConfig,
        { service: 'feishu', action: 'fetch_document', input: {} },
        undefined,
        fakeHttp({ runError: error }).fn,
      ),
    ).rejects.toMatchObject({ code: 'authentication_required' })
  })

  it('maps connection failure to connector_unavailable', async () => {
    await expect(
      resolveImportConnectionName(
        connectorConfig,
        'feishu',
        undefined,
        undefined,
        fakeHttp({ apps: new Error('OpenConnector 连接失败：fetch failed') }).fn,
      ),
    ).rejects.toMatchObject({ code: 'connector_unavailable' })
  })

  it('keeps a disconnected app out of connection resolution', async () => {
    const disconnectedOnly = {
      success: true,
      message: 'OK',
      data: [{ id: 'c2', service: 'notion', status: 'disconnected', alias: 'old', isDefault: false }],
      meta: {},
    }
    try {
      await resolveImportConnectionName(
        connectorConfig,
        'notion',
        undefined,
        undefined,
        fakeHttp({ apps: disconnectedOnly }).fn,
      )
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ImportConnectorError)
      expect((error as ImportConnectorError).code).toBe('no_connection')
    }
  })

  it('still satisfies the ImportActionRunner injection seam used by services', () => {
    const runner: ImportActionRunner = runImportConnectorAction
    expect(typeof runner).toBe('function')
  })
})
