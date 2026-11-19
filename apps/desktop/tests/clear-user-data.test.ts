import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 数据清理链路（app:clear-user-data → will-quit wipe）的关键行为单测。
 * 不拉起真实 Electron：直接测可单测的三块纯逻辑语义。
 */

// ---- 1. rmWithRetry 重试语义（Windows EBUSY/EPERM 自愈） ----
describe('data wipe: rmWithRetry 语义（Windows 句柄占用自愈）', () => {
  it('rm 失败后按线性退避重试，最终成功', async () => {
    vi.useFakeTimers()
    try {
      const rmMock = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
        .mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
        .mockResolvedValueOnce(undefined)
      const delays: number[] = []
      const { rmWithRetry } = await import('../src/main/clear-user-data')
      // 用注入的时钟/删除函数，避免真实 IO
      const promise = rmWithRetry('/data/dir', {
        attempts: 5,
        rm: rmMock as unknown as typeof import('node:fs/promises').rm,
        sleep: async (ms: number) => { delays.push(ms) },
      })
      await promise
      expect(rmMock).toHaveBeenCalledTimes(3)
      expect(delays).toEqual([300, 600]) // 线性退避 300ms * attempt
    } finally {
      vi.useRealTimers()
    }
  })

  it('重试耗尽后抛出最后一次错误（调用方放弃重启）', async () => {
    const rmMock = vi.fn().mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
    const { rmWithRetry } = await import('../src/main/clear-user-data')
    await expect(rmWithRetry('/data/dir', {
      attempts: 2,
      rm: rmMock as unknown as typeof import('node:fs/promises').rm,
      sleep: async () => {},
    })).rejects.toThrow('EBUSY')
    expect(rmMock).toHaveBeenCalledTimes(2)
  })
})

// ---- 2. 登录态备份/还原编排 ----
describe('data wipe: 登录态备份/还原', () => {
  afterEach(() => vi.restoreAllMocks())

  it('备份目录会先创建；缺失的登录文件跳过；删除后还原存在的文件', async () => {
    const createdDirs: string[] = []
    const copied: Array<[string, string]> = []
    const fs = {
      rm: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn(async (dir: string) => { createdDirs.push(dir) }),
      copyFile: vi.fn(async (from: string, to: string) => {
        // 模拟：credentials.json 存在，account-keyring.json 不存在（ENOENT 被吞）
        if (from.endsWith('account-keyring.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        copied.push([from, to])
      }),
      existsSync: (p: string) => p.endsWith('credentials.json'),
    }
    const { wipePreservingLogin } = await import('../src/main/clear-user-data')
    const result = await wipePreservingLogin({
      dataDirectory: '/data/EverRoom',
      pid: 123,
      join: (...parts: string[]) => parts.join('/'),
      dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
      fs,
      sleep: async () => {},
    })
    // 备份目录（父目录下 pid 后缀）与数据目录本身都被创建过
    expect(createdDirs).toContain('/data/.everroom-login-backup-123')
    expect(createdDirs).toContain('/data/EverRoom')
    // 还原的只有存在的 credentials.json
    expect(copied.filter(([, to]) => to === '/data/EverRoom/credentials.json')).toHaveLength(1)
    expect(result.preservedFiles).toEqual(['credentials.json'])
    expect(result.wiped).toBe(true)
  })

  it('整目录删除失败时返回 wiped:false（调用方不得重启）', async () => {
    const fs = {
      rm: vi.fn().mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' })),
      mkdir: vi.fn().mockResolvedValue(undefined),
      copyFile: vi.fn().mockResolvedValue(undefined),
      existsSync: () => true,
    }
    const { wipePreservingLogin } = await import('../src/main/clear-user-data')
    const result = await wipePreservingLogin({
      dataDirectory: '/data/EverRoom',
      pid: 1,
      join: (...parts: string[]) => parts.join('/'),
      dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
      fs,
      sleep: async () => {},
    })
    expect(result.wiped).toBe(false)
  })
})
