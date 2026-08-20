import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { OoCliBridge } from '../src/main/open-connector/oo-cli-bridge'

const temporaryDirectories: string[] = []

async function fixture(): Promise<{ bridge: OoCliBridge; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'everroom-oo-cli-'))
  temporaryDirectories.push(directory)
  const script = join(directory, 'fake-oo.mjs')
  await writeFile(script, `
const args = process.argv.slice(2)
if (args[0] === 'version') {
  process.stdout.write(JSON.stringify({ version: '9.9.9' }))
} else if (args[0] === 'connector' && args[1] === 'search') {
  const query = args.at(-1)
  if (query === 'slow') setTimeout(() => process.stdout.write('[]'), 10000)
  else if (query === 'leak') {
    process.stdout.write('{"token":"top-')
    setTimeout(() => {
      process.stdout.write('secret-token"}')
      process.stderr.write('warning: ' + process.env.OO_CONNECTOR_TOKEN)
    }, 10)
  }
  else process.stdout.write(JSON.stringify([{ service: 'mail', name: 'send', description: 'Send', authenticated: true }]))
} else if (args[0] === 'connector' && args[1] === 'run') {
  const input = JSON.parse(args[args.indexOf('--data') + 1])
  process.stdout.write(JSON.stringify({ ok: true, input }))
} else {
  process.stderr.write('unsupported command')
  process.exitCode = 2
}
`)
  return {
    directory,
    bridge: new OoCliBridge({
      executable: process.execPath,
      argumentPrefix: [script],
      baseUrl: 'http://127.0.0.1:3000',
      runtimeToken: 'top-secret-token',
      configDirectory: join(directory, 'config'),
      dataDirectory: join(directory, 'data'),
      environment: {},
    }),
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('OoCliBridge', () => {
  it('executes the command allowlist as JSON and redacts action input from events', async () => {
    const { bridge } = await fixture()
    const events: string[] = []
    bridge.onCommand((event) => {
      if (event.type === 'started') events.push(event.command)
    })

    const result = await bridge.execute({
      requestId: 'request_12345678',
      command: {
        kind: 'run',
        service: 'mail',
        action: 'send',
        input: { subject: 'private value' },
      },
    })

    expect(result.data).toEqual({ ok: true, input: { subject: 'private value' } })
    expect(events).toEqual(['oo connector run mail --action send --data <json> --json'])
    expect(events[0]).not.toContain('private value')
    expect(bridge.gatewayEnvironment()).toMatchObject({
      NXCORE_CLI_CONNECTOR_URL: 'http://127.0.0.1:3000',
      NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN: 'top-secret-token',
    })
  })

  it('rejects identifiers that could become shell syntax', async () => {
    const { bridge } = await fixture()
    await expect(bridge.execute({
      requestId: 'request_12345678',
      command: { kind: 'run', service: 'mail;touch', action: 'send', input: {} },
    })).rejects.toThrow('Service格式无效')
  })

  it('separates free-text search input from CLI options', async () => {
    const { bridge } = await fixture()
    const commands: string[] = []
    bridge.onCommand((event) => {
      if (event.type === 'started') commands.push(event.command)
    })

    await bridge.execute({
      requestId: 'request_12345678',
      command: { kind: 'search', query: '--help' },
    })

    expect(commands).toEqual(['oo connector search --json -- --help'])
  })

  it('redacts runtime tokens from streamed output and command results', async () => {
    const { bridge } = await fixture()
    const output: string[] = []
    bridge.onCommand((event) => {
      if (event.type === 'output') output.push(event.text)
    })

    const result = await bridge.execute({
      requestId: 'request_12345678',
      command: { kind: 'search', query: 'leak' },
    })

    expect(result.data).toEqual({ token: '<redacted>' })
    expect(result.stderr).toBe('warning: <redacted>')
    expect(output.join('')).not.toContain('top-secret-token')
    expect(output.join('')).toContain('<redacted>')
  })

  it('cancels an active CLI process', async () => {
    const { bridge } = await fixture()
    const promise = bridge.execute({
      requestId: 'request_12345678',
      command: { kind: 'search', query: 'slow' },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(bridge.cancel('request_12345678')).toBe(true)
    await expect(promise).rejects.toThrow(/执行失败|exit/i)
  })
})
