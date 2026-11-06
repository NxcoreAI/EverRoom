import { useLocale } from '@/i18n/LocaleContext'
import { showToast } from '@/state/toast'
import { FileGlyphIcon } from '@/office-proto/pages/parts'

import type { AgentTurnFile, AgentTurnFiles } from './agentTurnFiles'

function originLabel(origin: AgentTurnFile['origin'], format: string, t: ReturnType<typeof useLocale>['t']): string {
  if (origin === 'exported') return t('surface:agentChat.turnFileExported', { format: format.toUpperCase() })
  return t('surface:agentChat.turnFileCreated', { format: format.toUpperCase() })
}

/** 同一文件在请求未返回前不重复发起（连点 / 重渲染触发的二次调用）。 */
const openingIds = new Set<string>()

async function openTurnFile(file: AgentTurnFile, onError: (message: string) => void): Promise<void> {
  const api = window.nxcore?.files
  if (!api?.openOriginal) {
    onError('surface:agentChat.turnFileOpenUnavailable')
    return
  }
  if (openingIds.has(file.fileEntryId)) return
  openingIds.add(file.fileEntryId)
  try {
    // 与资料库 / 产物库 / 首页文件三个入口对齐：带上 contentHash，主进程就不必
    // 每次读盘重算；catalog 取不到时仍由主进程兜底（effectiveHash 回退 hashFileBytes）。
    let contentHash: string | undefined
    try {
      contentHash = (await api.catalogEntry?.(file.fileEntryId))?.contentHash ?? undefined
    } catch {
      contentHash = undefined
    }
    const result = await api.openOriginal(file.fileEntryId, file.name, contentHash, { editable: true })
    // openedWith === 'external' 表示已交给系统默认应用打开，属正常结果，不报错。
    if (result.openedWith === 'external') {
      console.info('[agent] 文件已交给系统默认应用打开', { fileEntryId: file.fileEntryId })
    }
  } catch (error) {
    console.warn('[agent] 打开文件失败', { fileEntryId: file.fileEntryId, error })
    onError('surface:agentChat.turnFileOpenFailed')
  } finally {
    openingIds.delete(file.fileEntryId)
  }
}

/**
 * 「本轮产生的文件」卡条：DSH 产物卡语义——assistant 正文下方按产生顺序列出
 * 本轮生成的关键文件，点击打开可编辑视图。数据来自工具结果（见 agentTurnFiles.ts），
 * 与时间线/进度卡互补：时间线讲过程，这里给最终产物的落点。
 */
export function AgentTurnFilesCard({ files, onOpenError }: { files: AgentTurnFiles; onOpenError?: (message: string) => void }) {
  const { t } = useLocale()
  if (files.length === 0) return null
  const reportError = (key: string) => {
    const message = t(key)
    if (onOpenError) onOpenError(message)
    else showToast({ title: message })
  }
  return (
    <div className="agent-turn-files" role="list" aria-label={t('surface:agentChat.turnFilesLabel')}>
      {files.map((file) => (
        <button
          key={file.fileEntryId}
          type="button"
          role="listitem"
          className="agent-turn-file"
          title={t('surface:agentChat.turnFileOpenTitle', { name: file.name })}
          onClick={() => void openTurnFile(file, reportError)}
        >
          <span className="agent-turn-file-icon" aria-hidden="true">
            <FileGlyphIcon kind={file.format} size={28} />
          </span>
          <span className="agent-turn-file-copy">
            <strong>{file.name}</strong>
            <small>{originLabel(file.origin, file.format, t)}</small>
          </span>
        </button>
      ))}
    </div>
  )
}
