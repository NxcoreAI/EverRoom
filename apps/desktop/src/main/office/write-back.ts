import { existsSync } from 'node:fs'
import { chmod, copyFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/**
 * 把编辑器保存后的工作副本写回用户磁盘上的原文件。
 *
 * 适用于「从访达/资源管理器直接打开」的文件：用户认为编辑的就是磁盘上那份，
 * 保存后 Word/WPS/Keynote 等外部程序必须能看到新内容。
 *
 * 写法：同目录临时文件 + rename，保证外部程序读到的要么是旧版本、要么是完整
 * 新版本，不会撞上写了一半的文档；目标存在且是符号链接时写入其真实文件，
 * 保留用户的链接结构。
 */
export async function writeBackEditedDocument(workingCopyPath: string, targetPath: string): Promise<void> {
  const target = existsSync(targetPath) ? await realpath(targetPath) : targetPath
  const directory = dirname(target)
  // 原文件所在目录被移走/拔盘时不重建路径：那属于「文件已不在原位」，
  // 让保存回写失败并提示，比在旧位置凭空造一份文件更安全。
  if (!existsSync(directory)) throw new Error(`The original folder is unavailable: ${directory}`)
  // 原文件可能带着只读位（从压缩包/只读盘复制出来的常见情况）。用编辑器的
  // 语义处理：保存成功即认为用户要的是「可继续编辑的文件」，补上 owner 写位；
  // 其余权限位保持不变。
  const existingMode = existsSync(target) ? (await stat(target)).mode & 0o777 : null
  const tempPath = join(directory, `.${basename(target)}.everroom-${randomUUID()}.tmp`)
  try {
    await copyFile(workingCopyPath, tempPath)
    if (existingMode !== null) await chmod(tempPath, existingMode | 0o200)
    await rename(tempPath, target)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}
