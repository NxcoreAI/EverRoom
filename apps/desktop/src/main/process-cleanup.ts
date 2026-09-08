import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 受管子进程（gateway / memory-core / knowledge）的 pid 登记与回收兜底。
 *
 * Windows 上父进程被强杀/崩溃时没有任何机制连带回收子进程树（无 PDEATHSIG、
 * 无 Job Object），残留进程会锁住 SQLite/端口，导致"重启也不行"（issue #179）：
 * 残留 gateway 让新实例 waitUntilReady 超时，残留 memory-core/knowledge 被
 * start() 的 probe 误判为「可复用外部实例」并带着不匹配的 apiKey 静默 401。
 *
 * 这里提供三层兜底：
 * 1. spawn 后写 `<dataDir>/runtime/<name>.pid.json`，下次启动早期按登记清理
 *    （校验命令行确实含本应用入口，防 pid 复用误杀无辜进程）；
 * 2. process.on('exit') 同步击杀内存登记的存活 pid（win32 only——POSIX 有
 *    before-quit 的进程组语义，正常退出路径已覆盖，不改变 macOS 行为）；
 * 3. killProcessTreeSync 供各 supervisor 复用（win32 = taskkill /T /F）。
 */

interface ProcessRecord {
  pid: number
  /** 出现在子进程命令行中的本应用入口路径片段，用于清理时防 pid 复用误杀。 */
  entry: string
  startedAt: string
}

/** 进程名 → pid 的内存登记（exit 兜底钩子用）。 */
const tracked = new Map<string, number>()

export function killProcessTreeSync(pid: number, signal: NodeJS.Signals = 'SIGKILL'): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    // 非组长进程无进程组语义，退回单杀。
  }
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但属于其他用户；ESRCH = 已退出。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function commandLineOf(pid: number): string | null {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'wmic',
      ['process', 'where', `processid=${String(pid)}`, 'get', 'CommandLine', '/value'],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
    )
    if (result.status !== 0) return null
    const match = result.stdout.match(/^CommandLine=(.+)$/m)
    return match ? match[1]!.trim() : null
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0) return null
  return result.stdout.trim() || null
}

function recordPath(runtimeDirectory: string, name: string): string {
  return join(runtimeDirectory, `${name}.pid.json`)
}

export function registerProcessRecord(runtimeDirectory: string, name: string, pid: number | undefined, entry: string): void {
  if (!pid) return
  tracked.set(name, pid)
  const path = recordPath(runtimeDirectory, name)
  const record: ProcessRecord = { pid, entry, startedAt: new Date().toISOString() }
  void mkdir(dirname(path), { recursive: true })
    .then(() => writeFile(path, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 }))
    .catch((error: unknown) => {
      console.warn(`[process-cleanup] 无法写入 ${name} 的 pid 登记：`, error)
    })
}

export function forgetProcessRecord(runtimeDirectory: string, name: string): void {
  tracked.delete(name)
  void rm(recordPath(runtimeDirectory, name), { force: true }).catch(() => undefined)
}

/**
 * 退出兜底（win32 only）：主进程无论从哪条路径退出，同步击杀仍存活的受管子进程。
 * before-quit 的异步清理在崩溃/强杀场景不会执行；POSIX 正常退出已有进程组语义，
 * 保持 macOS 现有行为不变。
 */
export function installExitCleanupHook(): void {
  if (process.platform !== 'win32') return
  process.on('exit', () => {
    for (const pid of tracked.values()) killProcessTreeSync(pid)
  })
}

/**
 * 启动早期清理上次残留：读 runtime 目录全部 *.pid.json，pid 仍存活且命令行包含
 * 登记入口的整树击杀；pid 已死或被复用（命令行不匹配）只删登记。
 * 清理后 start() 的 probe 不再误判「可复用实例」，新实例可正常抢占端口/数据库。
 */
export async function cleanupStaleProcessRecords(runtimeDirectory: string): Promise<string[]> {
  const cleaned: string[] = []
  let files: string[]
  try {
    files = (await readdir(runtimeDirectory)).filter((file) => file.endsWith('.pid.json'))
  } catch {
    return cleaned
  }
  for (const file of files) {
    const path = join(runtimeDirectory, file)
    const name = file.replace(/\.pid\.json$/, '')
    let record: ProcessRecord | null = null
    try {
      record = JSON.parse(await readFile(path, 'utf8')) as ProcessRecord
    } catch {
      record = null
    }
    if (record && Number.isInteger(record.pid) && typeof record.entry === 'string' && processAlive(record.pid)) {
      const commandLine = commandLineOf(record.pid)
      if (commandLine && commandLine.includes(record.entry)) {
        killProcessTreeSync(record.pid)
        cleaned.push(`${name} pid=${String(record.pid)}`)
        console.warn(`[process-cleanup] 已清理上次残留的 ${name} 进程树（pid=${String(record.pid)}）`)
      }
    }
    await rm(path, { force: true }).catch(() => undefined)
  }
  return cleaned
}
