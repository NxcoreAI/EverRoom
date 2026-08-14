import { ExternalLink, Search, X } from 'lucide-react'
import type { FormEvent } from 'react'

import type { EvidenceSearchResult } from '../../../../../shared/sources'

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
  return (
    <>
      <form className="evidence-search" role="search" onSubmit={onSearch}>
        <label>
          <Search aria-hidden="true" strokeWidth={1.8} />
          <input value={query} aria-label="搜索证据内容" placeholder="搜索已解析的文档内容" onChange={(event) => onQueryChange(event.target.value)} />
        </label>
        <button type="submit" className="secondary-button" disabled={searching || !query.trim()}>{searching ? '搜索中' : '搜索'}</button>
        {results !== null ? (
          <button type="button" className="icon-button" title="清除搜索" aria-label="清除搜索" onClick={onClear}>
            <X aria-hidden="true" strokeWidth={1.8} />
          </button>
        ) : null}
      </form>

      {results !== null ? (
        <section className="evidence-search-results" aria-label="证据搜索结果">
          <div className="evidence-results-head"><strong>{results.length} 条结果</strong><span>来自当前文件版本</span></div>
          {results.length === 0 ? <div className="evidence-results-empty">没有找到相关证据。</div> : null}
          {results.map((result) => (
            <button type="button" key={result.id} className="evidence-result" onClick={() => onOpen(result)}>
              <span className="evidence-result-source">
                <strong>{result.fileName}</strong>
                <small>{result.sourceName} · {result.startLine === result.endLine ? `第 ${result.startLine} 行` : `第 ${result.startLine}-${result.endLine} 行`}</small>
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
