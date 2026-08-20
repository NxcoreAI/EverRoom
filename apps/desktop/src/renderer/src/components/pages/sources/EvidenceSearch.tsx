import { ExternalLink, Search, X } from 'lucide-react'
import type { FormEvent } from 'react'

import type { EvidenceSearchResult } from '../../../../../shared/sources'
import { useLocale } from '@/i18n/LocaleContext'

export function EvidenceSearch({
  query,
  results,
  searching,
  onQueryChange,
  onSearch,
  onClear,
  onOpen,
}: {
  query: string
  results: EvidenceSearchResult[] | null
  searching: boolean
  onQueryChange: (value: string) => void
  onSearch: (event: FormEvent<HTMLFormElement>) => void
  onClear: () => void
  onOpen: (result: EvidenceSearchResult) => void
}) {
  const { t } = useLocale()
  return (
    <>
      <form className="evidence-search" role="search" onSubmit={onSearch}>
        <label>
          <Search aria-hidden="true" strokeWidth={1.8} />
          <input value={query} aria-label={t('搜索证据内容')} placeholder={t('搜索已解析的文档内容')} onChange={(event) => onQueryChange(event.target.value)} />
        </label>
        <button type="submit" className="secondary-button" disabled={searching || !query.trim()}>{t(searching ? '搜索中' : '搜索')}</button>
        {results !== null ? (
          <button type="button" className="icon-button" title={t('清除搜索')} aria-label={t('清除搜索')} onClick={onClear}>
            <X aria-hidden="true" strokeWidth={1.8} />
          </button>
        ) : null}
      </form>

      {results !== null ? (
        <section className="evidence-search-results" aria-label={t('证据搜索结果')}>
          <div className="evidence-results-head"><strong>{t('{count} 条结果', { count: results.length })}</strong><span>{t('来自当前文件版本')}</span></div>
          {results.length === 0 ? <div className="evidence-results-empty">{t('没有找到相关证据。')}</div> : null}
          {results.map((result) => (
            <button type="button" key={result.id} className="evidence-result" onClick={() => onOpen(result)}>
              <span className="evidence-result-source">
                <strong>{result.fileName}</strong>
                <small>{result.sourceName} · {result.startLine === result.endLine ? t('第 {line} 行', { line: result.startLine }) : t('第 {start}-{end} 行', { start: result.startLine, end: result.endLine })}</small>
              </span>
              <span className="evidence-result-text">{result.text}</span>
              <ExternalLink aria-hidden="true" strokeWidth={1.8} />
            </button>
          ))}
        </section>
      ) : null}
    </>
  )
}
