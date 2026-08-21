import { useEffect, useState } from 'react'
import { ArrowRight, Settings2, X } from 'lucide-react'
import { useLocale } from '@/i18n/LocaleContext'
import { MEMORY_TAB_EVENT } from '../../MemoryPipelineStatus'

/**
 * 首次连接某类连接器（gmail / google-calendar / google-docs / notion …）后的
 * 过滤偏好引导：告诉用户「偏好 = 让系统明确理解什么数据、不理解什么数据」，
 * 给例子，并可当场编辑保存（或稍后去记忆页 · 过滤规则）。
 * 某类 provider 只在第一次连接成功后出现一次。
 * 连接的首同步被 gateway 暂缓（deferFirstSync），等本弹框关闭（偏好设置完成
 * 或用户跳过）后由 onDone 触发——首批数据在偏好生效后才进入过滤器。
 */
export function FilterPreferenceGuideDialog({ provider, onClose }: {
  provider: string
  onClose: () => void
}) {
  const { t } = useLocale()
  const [current, setCurrent] = useState('')
  const [draft, setDraft] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.nxcore?.ingest.getFilterRules()
      .then((rules) => {
        setCurrent(rules.preference)
        setDraft(rules.preference)
      })
      .catch(() => setDraft(''))
      .finally(() => setLoaded(true))
  }, [])

  const save = async () => {
    const content = draft.trim()
    if (!content) return
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.ingest.updateFilterPreference(content)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('surface:filterGuide.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const providerName = provider === 'gmail' ? 'Gmail'
    : provider === 'outlook' ? 'Outlook'
      : provider === 'google-docs' ? 'Google Docs'
        : provider === 'google-calendar' ? 'Google Calendar'
          : provider === 'notion' ? 'Notion' : provider

  return (
    <div className="evidence-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section className="evidence-dialog filter-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="filter-guide-title">
        <header className="evidence-dialog-head">
          <div>
            <span className="filter-guide-kind"><Settings2 aria-hidden="true" strokeWidth={1.7} /> {providerName}</span>
            <h2 id="filter-guide-title">{t('surface:filterGuide.title')}</h2>
          </div>
          <button type="button" className="icon-button" title={t('surface:filterGuide.close')} aria-label={t('surface:filterGuide.close')} onClick={onClose}>
            <X aria-hidden="true" strokeWidth={1.8} />
          </button>
        </header>
        <div className="filter-guide-body">
          <p className="filter-guide-lead">{t('surface:filterGuide.lead')}</p>
          <p className="filter-guide-lead">{t('surface:filterGuide.leadExample')}</p>

          <h3>{t('surface:filterGuide.exampleTitle')}</h3>
          <pre className="filter-guide-example">{t('surface:filterGuide.example')}</pre>

          <h3>{t('surface:filterGuide.editTitle')}</h3>
          {loaded ? (
            <textarea
              className="filter-guide-editor"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={8}
              maxLength={4096}
              placeholder={t('surface:filterGuide.placeholder')}
            />
          ) : (
            <p className="mem-loading">{t('surface:filterGuide.loading')}</p>
          )}
          {error ? <p className="mem-inline-error">{error}</p> : null}
        </div>
        <footer className="filter-guide-foot">
          <button type="button" className="ghost" onClick={() => {
            onClose()
            window.dispatchEvent(new CustomEvent('nxcore:app:navigate', { detail: { page: 'memory' } }))
            window.dispatchEvent(new CustomEvent(MEMORY_TAB_EVENT, { detail: { tab: 'filter-rules' } }))
          }}>
            <ArrowRight aria-hidden="true" strokeWidth={1.7} />
            {t('surface:filterGuide.goToRules')}
          </button>
          <span className="filter-guide-actions">
            {draft.trim() !== current.trim() ? (
              <button type="button" className="mem-primary" disabled={busy || !draft.trim()} onClick={() => void save()}>
                {t('surface:filterGuide.save')}
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={onClose}>{t('surface:filterGuide.later')}</button>
          </span>
        </footer>
      </section>
    </div>
  )
}
