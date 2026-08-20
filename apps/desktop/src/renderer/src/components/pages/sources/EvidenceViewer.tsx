import { AlertCircle, FileText, FolderOpen, RefreshCw, X } from 'lucide-react'
import { useEffect } from 'react'

import type { EvidenceDocument } from '../../../../../shared/sources'
import { formatDate } from './sourceFormatters'
import { useLocale } from '@/i18n/LocaleContext'

export function EvidenceViewer({
  evidence,
  activeBlockId,
  onClose,
  onShowFile,
}: {
  evidence: EvidenceDocument
  activeBlockId: string | null
  onClose: () => void
  onShowFile: () => void
}) {
  const { locale, t } = useLocale()
  useEffect(() => {
    if (!activeBlockId) return
    window.document.getElementById(`evidence-${activeBlockId}`)?.scrollIntoView({ block: 'center' })
  }, [activeBlockId, evidence.blocks])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <div className="evidence-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section className="evidence-dialog" role="dialog" aria-modal="true" aria-labelledby="evidence-dialog-title">
        <header className="evidence-dialog-head">
          <div>
            <span>{t('证据查看')}</span><h2 id="evidence-dialog-title">{evidence.fileName}</h2>
            <small>{evidence.relativePath} · {t('当前版本')} · {formatDate(evidence.modifiedAt, locale, t)}</small>
          </div>
          <span className="evidence-dialog-actions">
            <button type="button" className="icon-button" title={t(evidence.exists ? '打开来源' : '原始文件已不存在')} aria-label={t('打开来源')} disabled={!evidence.exists} onClick={onShowFile}>
              <FolderOpen aria-hidden="true" strokeWidth={1.8} />
            </button>
            <button type="button" className="icon-button" title={t('关闭')} aria-label={t('关闭证据查看')} onClick={onClose}>
              <X aria-hidden="true" strokeWidth={1.8} />
            </button>
          </span>
        </header>
        <div className="evidence-dialog-body">
          {evidence.status === 'pending' || evidence.status === 'running' ? (
            <div className="evidence-viewer-state"><RefreshCw aria-hidden="true" strokeWidth={1.8} />{t('正在解析当前版本...')}</div>
          ) : null}
          {evidence.status === 'unsupported' ? (
            <div className="evidence-viewer-state"><FileText aria-hidden="true" strokeWidth={1.8} />{t('该格式将在接入 Docling 后解析。')}</div>
          ) : null}
          {evidence.status === 'failed' ? (
            <div className="evidence-viewer-state error"><AlertCircle aria-hidden="true" strokeWidth={1.8} />{evidence.error ?? t('解析失败')}</div>
          ) : null}
          {evidence.status === 'success' && evidence.blocks.length === 0 ? (
            <div className="evidence-viewer-state">{t('当前文档没有可提取的文本段落。')}</div>
          ) : null}
          {evidence.status === 'success' ? evidence.blocks.map((block) => (
            <article id={`evidence-${block.id}`} key={block.id} className="evidence-block" data-kind={block.kind} data-active={String(activeBlockId === block.id)}>
              <div className="evidence-block-location">
                <span>{block.pageNumber ? t('第 {page} 页', { page: block.pageNumber }) : block.startLine === block.endLine ? t('第 {line} 行', { line: block.startLine }) : t('第 {start}-{end} 行', { start: block.startLine, end: block.endLine })}</span>
                {block.headingPath.length > 0 ? <small>{block.headingPath.join(' / ')}</small> : null}
              </div>
              {block.kind === 'heading' ? <h3 data-level={block.headingLevel ?? 1}>{block.text}</h3> : <p>{block.text}</p>}
            </article>
          )) : null}
        </div>
      </section>
    </div>
  )
}
