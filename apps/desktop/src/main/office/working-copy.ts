import { chmodSync, statSync } from 'node:fs'

/**
 * 工作副本必须可写。原文件经常是只读的（导出件、同步盘占位、刻盘归档），
 * `copyFile` 会把权限位一起带过来，编辑器就只会给「另存为」。
 * 这里只补 owner 写位，其余权限保持不变；对既有缓存副本同样生效。
 */
export function ensureWorkingCopyWritable(filePath: string): void {
  try {
    const mode = statSync(filePath).mode & 0o777
    if ((mode & 0o200) !== 0) return
    chmodSync(filePath, mode | 0o200)
  } catch {
    // 权限修正失败不阻断打开：编辑器仍可另存为，报错路径保持原样。
  }
}
