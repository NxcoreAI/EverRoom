import { copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

/** 可注入的最小 fs 面（生产用默认实现，测试注入内存版）。 */
export interface WipeFilesystem {
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>
  mkdir(path: string, options: { recursive: boolean }): Promise<void>
  copyFile(from: string, to: string): Promise<void>
  existsSync(path: string): boolean
}

/**
 * 带重试的目录删除：Windows 上杀软扫描与 Chromium 缓存句柄延迟释放常导致
 * EBUSY/EPERM（POSIX 的 unlink 语义允许删除打开中的文件，几乎不受影响）。
 * 线性退避重试，耗尽后抛出由调用方决定是否放弃。
 */
export async function rmWithRetry(
  target: string,
  deps: {
    attempts?: number
    rm?: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<void> {
  const attempts = deps.attempts ?? 5
  const rmImpl = deps.rm ?? ((path: string, options: { recursive: boolean; force: boolean }) => rm(path, options))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rmImpl(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= attempts) throw error
      await sleep(300 * attempt)
    }
  }
}

export interface WipeOptions {
  dataDirectory: string
  pid: number
  join?: typeof join
  dirname?: typeof dirname
  fs?: Partial<WipeFilesystem>
  sleep?: (ms: number) => Promise<void>
}

export interface WipeResult {
  /** 整目录删除是否成功（false 时调用方不得 relaunch）。 */
  wiped: boolean
  /** 成功还原的登录文件名（备份缺失的文件不会出现在这里）。 */
  preservedFiles: string[]
}

const DEFAULT_FS: WipeFilesystem = {
  rm: (path, options) => rm(path, options),
  mkdir: async (path, options) => {
    await mkdir(path, options)
  },
  copyFile,
  existsSync,
}

/**
 * 「删除本机全部数据（保留登录态）」的核心编排：
 *
 * 1. 把登录态文件（refresh token 与设备密钥）备份到数据目录的父目录下
 *    （同盘、必然存在可写；Windows 的 %TEMP% 可能被组策略清理，放那里
 *    有备份丢失风险）。pid 后缀防并发实例互踩。
 * 2. 带重试地整删数据目录。
 * 3. 重建数据目录并还原登录文件——重启后 restoreSession 用保留的
 *    token 自动恢复会话，设备无需重新批准。
 *
 * 必须在所有服务优雅关闭、窗口销毁之后调用（will-quit 阶段），
 * 否则 Windows 上会因文件句柄未释放而删除失败。
 */
export async function wipePreservingLogin(options: WipeOptions): Promise<WipeResult> {
  const { dataDirectory, pid } = options
  const joinImpl = options.join ?? join
  const dirnameImpl = options.dirname ?? dirname
  const fs = { ...DEFAULT_FS, ...options.fs }
  const preservedFiles: string[] = []
  const backupDir = joinImpl(dirnameImpl(dataDirectory), `.everroom-login-backup-${pid}`)
  await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined)

  let loginPreserved = false
  try {
    await fs.mkdir(backupDir, { recursive: true })
    // 逐文件吞错：未登录时这些文件本来就不存在（ENOENT 属预期），
    // 其余登录文件照常备份，不因单个缺失中断。
    for (const file of LOGIN_FILES) {
      await fs.copyFile(joinImpl(dataDirectory, file), joinImpl(backupDir, file)).catch(() => undefined)
    }
    loginPreserved = true
  } catch (error) {
    console.error('Failed to back up EverRoom login state before wipe', error)
  }

  let wiped = true
  try {
    await rmWithRetry(dataDirectory, { sleep: options.sleep, rm: fs.rm })
  } catch (error) {
    console.error('Failed to clear EverRoom user data', error)
    wiped = false
  }

  if (wiped && loginPreserved) {
    for (const file of LOGIN_FILES) {
      const backupPath = joinImpl(backupDir, file)
      if (!fs.existsSync(backupPath)) continue
      try {
        // 目录刚被整删，目标文件必须先重建目录树（recursive 同时补齐父目录）。
        await fs.mkdir(dataDirectory, { recursive: true })
        await fs.copyFile(backupPath, joinImpl(dataDirectory, file))
        preservedFiles.push(file)
      } catch (error) {
        console.error(`Failed to restore EverRoom login file ${file}`, error)
      }
    }
  }

  await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
  return { wiped, preservedFiles }
}

/** 登录态文件：refresh token（credentials.json）与设备密钥（account-keyring.json）。 */
export const LOGIN_FILES = ['credentials.json', 'account-keyring.json'] as const
