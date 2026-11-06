import { useLocale } from '@/i18n/LocaleContext'
import { showToast } from '@/state/toast'
import { FileGlyphIcon } from '@/office-proto/pages/parts'

import type { AgentTurnFile, AgentTurnFiles } from './agentTurnFiles'

function originLabel(origin: AgentTurnFile['origin'], format: string, t: ReturnType<typeof useLocale>['t']): string {
  if (origin === 'exported') return t('surface:agentChat.turnFileExported', { format: format.toUpperCase() })
  return t('surface:agentChat.turnFileCreated', { format: format.toUpperCase() })
}

function openTurnFile(file: AgentTurnFile, onError: (message: string) => void): void {
  const api = window.nxcore?.files
  if (!api?.openOriginal) {
    onError('surface:agentChat.turnFileOpenUnavailable')
    return
  }
  void api.openOriginal(file.fileEntryId, file.name, undefined, { editable: true }).catch(() => {
    onError('surface:agentChat.turnFileOpenFailed')
  })
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
          onClick={() => openTurnFile(file, reportError)}
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
