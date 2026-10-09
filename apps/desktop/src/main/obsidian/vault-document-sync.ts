import { basename, dirname, extname, join } from 'node:path'

import type { VaultNoteSaveResult, VaultNoteSnapshot } from '../../shared/obsidian'

/** vault-document-sync 依赖的最小服务面（ObsidianVaultService 的子集），便于单测注入。 */
export interface VaultDocumentSyncVaults {
  noteForDocument(documentId: string): { vaultId: string; resourceId: string } | null
  readNote(vaultId: string, resourceId: string): Promise<VaultNoteSnapshot>
  saveNote(vaultId: string, resourceId: string, markdown: string, expectedSourceHash: string): Promise<VaultNoteSaveResult>
  moveNote(vaultId: string, resourceId: string, relativePath: string, expectedSourceHash: string): Promise<VaultNoteSnapshot>
  trashNote(vaultId: string, resourceId: string, expectedSourceHash: string): Promise<void>
}

export interface VaultDocumentSyncDeps {
  vaults: VaultDocumentSyncVaults
  /** 网关侧正文序列化（GET /v1/documents/:id/markdown），与投影写回共用同一序列化器。 */
  documentMarkdown(documentId: string): Promise<string>
  /** 冲突时把网关文档回滚成磁盘内容，保持「文件是事实源」（roomId 由实现侧解析）。 */
  revertDocumentToDisk(input: {
    documentId: string
    vaultId: string
    resourceId: string
    relativePath: string
    sourceHash: string
    title: string
    markdown: string
  }): Promise<void>
}

export interface VaultDocumentSaveInfo {
  documentId: string
  previousTitle?: string
  nextTitle?: string
}

const CONFLICT_MESSAGE = 'VAULT_SOURCE_CONFLICT: Obsidian 已修改该笔记，请比较磁盘版本后重新编辑。'

export function titleForNotePath(relativePath: string): string {
  return basename(relativePath, extname(relativePath))
}

/** 标题 → Vault 内安全文件名（不允许路径分隔符与不可见字符，跟随 Obsidian 的处理方式）。 */
export function noteFileNameFromTitle(title: string, extension: string): string {
  const safe = title.replace(/[/\\:]/g, '-').replace(/[\x00-\x1f]/g, '').trim().replace(/^\.+/, '').trim()
  return `${safe || '未命名'}${extension || '.md'}`
}

/**
 * 编辑器保存后的写回：内容同步到笔记文件，标题变化时联动重命名。
 * vault 离线（目录不可读）时静默跳过——网关文档照常保存，目录恢复后由全量投影对齐。
 */
export async function pushDocumentSaveToVault(deps: VaultDocumentSyncDeps, info: VaultDocumentSaveInfo): Promise<void> {
  const note = deps.vaults.noteForDocument(info.documentId)
  if (!note) return
  let snapshot: VaultNoteSnapshot
  try {
    snapshot = await deps.vaults.readNote(note.vaultId, note.resourceId)
  } catch (cause) {
    console.warn('Vault note unavailable, skipped editor write-back', { documentId: info.documentId, cause })
    return
  }
  const markdown = await deps.documentMarkdown(info.documentId)
  let latest = snapshot
  if (latest.markdown !== markdown) {
    const saved = await deps.vaults.saveNote(note.vaultId, note.resourceId, markdown, latest.sourceHash)
    if (saved.status === 'conflict') {
      await deps.revertDocumentToDisk({
        documentId: info.documentId,
        vaultId: note.vaultId,
        resourceId: note.resourceId,
        relativePath: saved.snapshot.resource.relativePath,
        sourceHash: saved.snapshot.sourceHash,
        title: titleForNotePath(saved.snapshot.resource.relativePath),
        markdown: saved.snapshot.markdown,
      }).catch((cause) => {
        console.warn('Unable to revert document to disk version after vault conflict', { documentId: info.documentId, cause })
      })
      throw new Error(CONFLICT_MESSAGE)
    }
    latest = saved.snapshot
  }
  const renamed = info.previousTitle !== undefined && info.nextTitle !== undefined && info.nextTitle !== info.previousTitle
  if (!renamed) return
  const extension = extname(latest.resource.relativePath)
  const target = join(dirname(latest.resource.relativePath), noteFileNameFromTitle(info.nextTitle!, extension))
  if (target === latest.resource.relativePath) return
  await deps.vaults.moveNote(note.vaultId, note.resourceId, target, latest.sourceHash)
}

/** 房间内删除/清空回收站时联动把笔记文件移入 Vault 回收站；失败仅告警，不阻断网关删除。 */
export async function trashDocumentInVault(deps: VaultDocumentSyncDeps, documentId: string): Promise<void> {
  const note = deps.vaults.noteForDocument(documentId)
  if (!note) return
  try {
    const snapshot = await deps.vaults.readNote(note.vaultId, note.resourceId)
    await deps.vaults.trashNote(note.vaultId, note.resourceId, snapshot.sourceHash)
  } catch (cause) {
    console.warn('Unable to trash vault note for document', { documentId, cause })
  }
}
