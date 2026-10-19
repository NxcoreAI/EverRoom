import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentAccessInstaller } from './installer'

function planFixture(target: string, overrides: Partial<Parameters<AgentAccessInstaller['apply']>[0]> = {}) {
  return {
    target,
    url: 'http://127.0.0.1:8790/v1/mcp/agents',
    headers: { Authorization: 'Bearer evr_test' },
    mcpConfig: '{}',
    skillFiles: [
      { path: 'SKILL.md', content: '---\nname: everroom-agent\n---\nbody' },
      { path: 'references/tools.md', content: '# tools' },
    ],
    skillRoot: target === 'claude-code' || target === 'cursor' || target === 'codex'
      ? `~/.${target === 'cursor' ? 'cursor' : target === 'codex' ? 'codex' : 'claude'}/skills/everroom-agent/`
      : null,
    notes: [],
    ...overrides,
  }
}

const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'agent-access-installer-'))
  homes.push(home)
  return home
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

describe('AgentAccessInstaller', () => {
  it('claude-code：写技能目录 + 合并 ~/.claude.json 且保留既有配置', () => {
    const home = makeHome()
    const claudeJson = join(home, '.claude.json')
    writeFileSync(claudeJson, JSON.stringify({ otherSetting: true, mcpServers: { github: { url: 'x' } } }), 'utf8')
    const installer = new AgentAccessInstaller(home)

    const outcome = installer.apply(planFixture('claude-code'))
    expect(outcome.writtenFiles.some((file) => file.endsWith('SKILL.md'))).toBe(true)
    expect(outcome.manualSteps).toHaveLength(0)

    const config = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
      otherSetting: boolean
      mcpServers: Record<string, unknown>
    }
    expect(config.otherSetting).toBe(true)
    expect(config.mcpServers.github).toBeDefined()
    expect(config.mcpServers.everroom).toMatchObject({
      type: 'http',
      url: 'http://127.0.0.1:8790/v1/mcp/agents',
    })
    expect(outcome.backups.length).toBe(1)
  })

  it('cursor：新建 ~/.cursor/mcp.json 并写技能；重复安装幂等', () => {
    const home = makeHome()
    const installer = new AgentAccessInstaller(home)
    installer.apply(planFixture('cursor'))
    const outcome = installer.apply(planFixture('cursor'))

    const config = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(config.mcpServers.everroom).toMatchObject({ url: 'http://127.0.0.1:8790/v1/mcp/agents' })
    expect(outcome.backups.length).toBe(1) // 第二次安装时已有文件 → 备份一次
  })

  it('claude.json 损坏时不写入、返回手动步骤提示', () => {
    const home = makeHome()
    const claudeJson = join(home, '.claude.json')
    writeFileSync(claudeJson, '{broken', 'utf8')
    const installer = new AgentAccessInstaller(home)

    const outcome = installer.apply(planFixture('claude-code'))
    expect(outcome.notes.some((note) => note.includes('不是有效 JSON'))).toBe(true)
    expect(readFileSync(claudeJson, 'utf8')).toBe('{broken')
  })

  it('codex：只写技能目录，TOML 走手动片段且 token 已替换', () => {
    const home = makeHome()
    const installer = new AgentAccessInstaller(home)
    const outcome = installer.apply(planFixture('codex', {
      mcpConfig: '[mcp_servers.everroom]\nurl = "http://x"\nhttp_headers = { Authorization = "Bearer <token>" }',
    }))
    expect(outcome.manualSteps).toHaveLength(1)
    expect(outcome.manualSteps[0]!.content).toContain('"Bearer evr_test"')
    expect(outcome.manualSteps[0]!.content).not.toContain('<token>')
  })

  it('卸载：移除技能目录与配置键，保留其他服务器与用户配置', () => {
    const home = makeHome()
    const claudeJson = join(home, '.claude.json')
    writeFileSync(claudeJson, JSON.stringify({
      keep: 1,
      mcpServers: { github: { url: 'x' }, everroom: { url: 'y' } },
    }), 'utf8')
    const installer = new AgentAccessInstaller(home)
    installer.apply(planFixture('claude-code'))

    const outcome = installer.uninstall('claude-code')
    expect(outcome.removed.some((path) => path.includes('everroom-agent'))).toBe(true)
    const config = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
      keep: number
      mcpServers: Record<string, unknown>
    }
    expect(config.keep).toBe(1)
    expect(config.mcpServers.everroom).toBeUndefined()
    expect(config.mcpServers.github).toBeDefined()
  })

  it('宿主无技能机制（cherry-studio）时不写任何文件，只给片段', () => {
    const home = makeHome()
    const installer = new AgentAccessInstaller(home)
    const outcome = installer.apply(planFixture('cherry-studio'))
    expect(outcome.writtenFiles).toHaveLength(0)
    expect(outcome.manualSteps).toHaveLength(1)
    expect(outcome.notes.some((note) => note.includes('token'))).toBe(true)
    mkdirSync(join(home, 'unused'), { recursive: true })
  })
})
