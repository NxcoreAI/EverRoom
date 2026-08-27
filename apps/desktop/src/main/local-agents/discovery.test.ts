import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalAgentDiscovery, isSafeLocalAgentPath } from './discovery'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'everroom-local-agents-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('local agent discovery', () => {
  it('verifies executables from PATH without a shell and reports history separately', async () => {
    const root = await temporaryRoot()
    const bin = join(root, 'bin')
    const home = join(root, 'home')
    await mkdir(bin, { recursive: true })
    await mkdir(join(home, '.claude'), { recursive: true })
    const codex = join(bin, 'codex')
    await writeFile(codex, '#!/bin/sh\nprintf "codex-cli 9.9.9\\n"\n', 'utf8')
    await chmod(codex, 0o755)

    const discovery = createLocalAgentDiscovery({
      env: { PATH: [bin, '/usr/bin', '/bin'].join(delimiter) },
      home,
      platform: 'darwin',
      now: () => new Date('2026-08-26T00:00:00.000Z'),
      resolveLoginShellPath: false,
    })
    const agents = await discovery.scan()

    expect(agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'codex',
        executablePath: codex,
        version: 'codex-cli 9.9.9',
        callable: true,
        invocationSupported: true,
        status: 'verified',
      }),
      expect.objectContaining({
        provider: 'claude',
        executablePath: null,
        callable: false,
        historyAvailable: true,
        status: 'history_available',
      }),
    ]))
    expect(agents.some((agent) => agent.provider === 'opencode')).toBe(false)
  })

  it('does not mark a failing version probe as callable', async () => {
    const root = await temporaryRoot()
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    const opencode = join(bin, 'opencode')
    await writeFile(opencode, '#!/bin/sh\nexit 7\n', 'utf8')
    await chmod(opencode, 0o755)

    const agents = await createLocalAgentDiscovery({ env: { PATH: bin }, home: join(root, 'home'), resolveLoginShellPath: false }).scan()
    expect(agents).toEqual([])
  })
})

describe('isSafeLocalAgentPath', () => {
  it('rejects empty, root, and null-containing paths', () => {
    expect(isSafeLocalAgentPath('/usr/local/bin/codex')).toBe(true)
    expect(isSafeLocalAgentPath('')).toBe(false)
    expect(isSafeLocalAgentPath('/')).toBe(false)
    expect(isSafeLocalAgentPath('/tmp/codex\0bad')).toBe(false)
  })
})
