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
          <input value={query} aria-label={t('surface:evidenceSearch.searchEvidence')} placeholder={t('surface:evidenceSearch.searchParsedDocumentContent')} onChange={(event) => onQueryChange(event.target.value)} />
        </label>
        <button type="submit" className="secondary-button" disabled={searching || !query.trim()}>{t(searching ? 'surface:evidenceSearch.searching' : 'surface:evidenceSearch.search')}</button>
        {results !== null ? (
          <button type="button" className="icon-button" title={t('surface:evidenceSearch.clearSearch')} aria-label={t('surface:evidenceSearch.clearSearch')} onClick={onClear}>
            <X aria-hidden="true" strokeWidth={1.8} />
          </button>
        ) : null}
      </form>

      {results !== null ? (
        <section className="evidence-search-results" aria-label={t('surface:evidenceSearch.evidenceSearchResults')}>
          <div className="evidence-results-head"><strong>{t('surface:evidenceSearch.countResults', { count: results.length })}</strong><span>{t('surface:evidenceSearch.fromCurrentFileVersions')}</span></div>
          {results.length === 0 ? <div className="evidence-results-empty">{t('surface:evidenceSearch.noMatchingEvidenceFound')}</div> : null}
          {results.map((result) => (
            <button type="button" key={result.id} className="evidence-result" onClick={() => onOpen(result)}>
              <span className="evidence-result-source">
                <strong>{result.fileName}</strong>
                <small>{result.sourceName} · {result.startLine === result.endLine ? t('surface:evidenceSearch.lineLine', { line: result.startLine }) : t('surface:evidenceSearch.linesStartEnd', { start: result.startLine, end: result.endLine })}</small>
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
