import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentAccessInstallPlanDto } from '../gateway/agent-access-gateway-bridge'

/**
 * 安装代写落盘（PRD 7.1.2「安装技能与 MCP／CLI 连接」）：把网关生成的安装内容
 * 写进目标工具。原则：
 * - 只增改 everroom 自己的键/目录，绝不触碰用户其他配置；写入前先备份。
 * - JSON 配置（~/.claude.json、~/.cursor/mcp.json）合并 mcpServers.everroom；
 *   解析失败立即中止不写（宁可让用户手动贴片段）。
 * - TOML（~/.codex/config.toml）不做自动合并——返回片段由用户粘贴，避免破坏
 *   手写注释与结构。
 */

export interface InstallOutcome {
  writtenFiles: string[]
  backups: string[]
  /** 需要用户手动粘贴的配置片段（标题 + 内容）。 */
  manualSteps: Array<{ title: string; content: string }>
  notes: string[]
}

export interface UninstallOutcome {
  removed: string[]
  backups: string[]
}

export class AgentAccessInstaller {
  constructor(private readonly homeDirectory: string = homedir()) {}

  private tilde(absolute: string): string {
    return absolute.startsWith(this.homeDirectory)
      ? absolute.replace(this.homeDirectory, '~')
      : absolute
  }

  private backupFile(path: string, backups: string[]): void {
    if (!existsSync(path)) return
    const backupPath = `${path}.everroom-backup-${Date.now()}`
    copyFileSync(path, backupPath)
    backups.push(this.tilde(backupPath))
  }

  private writeSkillFiles(
    plan: AgentAccessInstallPlanDto,
    written: string[],
  ): string | null {
    if (!plan.skillRoot) return null
    const root = plan.skillRoot.replace(/^~(?=\/)/, this.homeDirectory)
    for (const file of plan.skillFiles) {
      const target = join(root, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.content, 'utf8')
      written.push(this.tilde(target))
    }
    return root
  }

  private readJsonObject(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) return {}
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }

  private mergeMcpServer(input: {
    configPath: string
    server: Record<string, unknown>
    written: string[]
    backups: string[]
    errors: string[]
  }): void {
    const { configPath, server, written, backups, errors } = input
    const config = this.readJsonObject(configPath)
    if (config === null) {
      errors.push(`${this.tilde(configPath)} 不是有效 JSON，已跳过（请手动粘贴配置片段）`)
      return
    }
    const servers = (config.mcpServers && typeof config.mcpServers === 'object'
      ? config.mcpServers as Record<string, unknown>
      : {}) as Record<string, unknown>
    servers.everroom = server
    config.mcpServers = servers
    mkdirSync(dirname(configPath), { recursive: true })
    this.backupFile(configPath, backups)
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    written.push(this.tilde(configPath))
  }

  private removeMcpServer(input: {
    configPath: string
    removed: string[]
    backups: string[]
  }): void {
    const { configPath, removed, backups } = input
    const config = this.readJsonObject(configPath)
    if (config === null) return
    const servers = config.mcpServers as Record<string, unknown> | undefined
    if (!servers || !('everroom' in servers)) return
    delete servers.everroom
    this.backupFile(configPath, backups)
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    removed.push(this.tilde(configPath))
  }

  private claudeConfig(): string {
    return join(this.homeDirectory, '.claude.json')
  }

  private cursorConfig(): string {
    return join(this.homeDirectory, '.cursor', 'mcp.json')
  }

  private serverConfigOf(plan: AgentAccessInstallPlanDto): Record<string, unknown> {
    // Cursor/通用 JSON 形态：{ url, headers }；Claude Code 加 type: http。
    return plan.target === 'claude-code'
      ? { type: 'http', url: plan.url, headers: plan.headers }
      : { url: plan.url, headers: plan.headers }
  }

  apply(plan: AgentAccessInstallPlanDto): InstallOutcome {
    const writtenFiles: string[] = []
    const backups: string[] = []
    const manualSteps: Array<{ title: string; content: string }> = []
    const errors: string[] = []

    const skillRoot = this.writeSkillFiles(plan, writtenFiles)

    if (plan.target === 'claude-code') {
      this.mergeMcpServer({
        configPath: this.claudeConfig(),
        server: this.serverConfigOf(plan),
        written: writtenFiles,
        backups,
        errors,
      })
    } else if (plan.target === 'cursor') {
      this.mergeMcpServer({
        configPath: this.cursorConfig(),
        server: this.serverConfigOf(plan),
        written: writtenFiles,
        backups,
        errors,
      })
    } else if (plan.target === 'codex') {
      manualSteps.push({
        title: '把以下内容并入 ~/.codex/config.toml（token 已替换为实际值）',
        content: plan.mcpConfig.replace(
          /Authorization = "Bearer <token>"/,
          `Authorization = ${JSON.stringify(plan.headers.Authorization ?? '')}`,
        ),
      })
    } else {
      manualSteps.push({ title: '按宿主支持的方式添加 MCP 服务器', content: plan.mcpConfig })
    }

    return {
      writtenFiles,
      backups,
      manualSteps,
      notes: [
        ...plan.notes,
        ...(skillRoot ? [`技能已写入 ${this.tilde(skillRoot)}`] : []),
        ...errors,
        '配置文件包含连接 token，请勿提交到版本库或分享给他人。',
      ],
    }
  }

  uninstall(target: string): UninstallOutcome {
    const removed: string[] = []
    const backups: string[] = []

    const skillRootsByTarget: Record<string, string | undefined> = {
      'claude-code': join(this.homeDirectory, '.claude', 'skills', 'everroom-agent'),
      cursor: join(this.homeDirectory, '.cursor', 'skills', 'everroom-agent'),
      codex: join(this.homeDirectory, '.codex', 'skills', 'everroom-agent'),
    }
    const skillRoot = skillRootsByTarget[target]
    if (skillRoot && existsSync(skillRoot)) {
      rmSync(skillRoot, { recursive: true, force: true })
      removed.push(this.tilde(skillRoot))
    }

    if (target === 'claude-code') {
      this.removeMcpServer({ configPath: this.claudeConfig(), removed, backups })
    } else if (target === 'cursor') {
      this.removeMcpServer({ configPath: this.cursorConfig(), removed, backups })
    }

    return { removed, backups }
  }
}
