import {
  BookOpenText,
  CheckCircle2,
  ChevronRight,
  FileText,
  Mic2,
  Sparkles,
} from 'lucide-react'

import type { PageId } from '@/data/navigation'
import { useLocale } from '@/i18n/LocaleContext'

import './HomePage.css'

// 演示内容已移除：最近访问/今日工作/活动预告待接入真实数据源，空列表时整个面板不渲染。
const RECENT_ITEMS: readonly string[] = []

const TODAY_ITEMS: readonly string[] = []

export function HomePage({
  onNavigate,
  onFocusAgent,
}: {
  onNavigate: (page: PageId) => void
  onFocusAgent: () => void
}) {
  const { t } = useLocale()
  return (
    <section className="workspace-home-surface" data-testid="workspace-home-surface">
      <div className="workspace-home-inner">
        <header className="workspace-home-heading">
          <h1>{t('surface:home.goodEvening')}</h1>
          <p>{t('surface:home.continueWhereYouLeftOffOrStartSomething')}</p>
        </header>

        <div className="workspace-home-grid">
          {RECENT_ITEMS.length > 0 ? (
          <section className="workspace-home-panel">
            <h2>{t('surface:home.recentlyOpened')}</h2>
            <div className="workspace-home-list">
              {RECENT_ITEMS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="workspace-home-list-item"
                  onClick={() => onNavigate('rooms')}
                >
                  <FileText aria-hidden="true" strokeWidth={1.8} />
                  <span>{item}</span>
                  <ChevronRight aria-hidden="true" strokeWidth={1.8} />
                </button>
              ))}
            </div>
          </section>
          ) : null}

          {TODAY_ITEMS.length > 0 ? (
          <section className="workspace-home-panel">
            <h2>{t('surface:home.todaySWork')}</h2>
            <div className="workspace-home-list">
              {TODAY_ITEMS.map((item) => (
                <button key={item} type="button" className="workspace-home-list-item is-muted" disabled>
                  <CheckCircle2 aria-hidden="true" strokeWidth={1.8} />
                  <span>{item}</span>
                </button>
              ))}
            </div>
          </section>
          ) : null}

          <section className="workspace-home-quick-start">
            <h2>{t('surface:home.quickStart')}</h2>
            <div className="workspace-quick-grid">
              <button type="button" className="workspace-quick-action" onClick={onFocusAgent}>
                <Sparkles aria-hidden="true" strokeWidth={1.8} data-tone="blue" />
                <span>{t('surface:home.askAi')}</span>
              </button>
              <button type="button" className="workspace-quick-action" onClick={() => onNavigate('docs')}>
                <Mic2 aria-hidden="true" strokeWidth={1.8} data-tone="violet" />
                <span>{t('surface:home.aiNotes')}</span>
              </button>
              <button type="button" className="workspace-quick-action" onClick={() => onNavigate('rooms')}>
                <BookOpenText aria-hidden="true" strokeWidth={1.8} data-tone="emerald" />
                <span>Context Room</span>
              </button>
            </div>
          </section>
        </div>
      </div>
    </section>
  )
}
