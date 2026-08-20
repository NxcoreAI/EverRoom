import './ContextRoomHomeSkeleton.css'
import { useLocale } from '../../i18n/LocaleContext'

function SkeletonLine({ width }: { width: string }) {
  return <span className="context-room-skeleton-block context-room-skeleton-line" style={{ width }} />
}

function SkeletonCard({ variant }: { variant: 'recommendation' | 'room' }) {
  return (
    <div className={`context-room-skeleton-card is-${variant}`} aria-hidden="true">
      <span className="context-room-skeleton-card-main">
        <span className="context-room-skeleton-block context-room-skeleton-icon" />
        <span className="context-room-skeleton-card-copy">
          <SkeletonLine width="42%" />
          <SkeletonLine width="78%" />
          {variant === 'room' ? <SkeletonLine width="28%" /> : null}
        </span>
      </span>
      {variant === 'recommendation' ? (
        <span className="context-room-skeleton-block context-room-skeleton-chip" />
      ) : (
        <span className="context-room-skeleton-menu"><i className="context-room-skeleton-block" /></span>
      )}
    </div>
  )
}

function SkeletonSectionTitle({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`context-room-skeleton-title${compact ? ' is-compact' : ''}`} aria-hidden="true">
      <SkeletonLine width="34px" />
      <SkeletonLine width="104px" />
    </div>
  )
}

export function ContextRoomHomeSkeleton() {
  const { t } = useLocale()
  return (
    <div className="context-room-home-loading" role="status" aria-label={t('正在加载 Context Room')}>
      <span className="context-room-skeleton-status">{t('正在加载 Context Room')}</span>
      <div className="context-room-home-loading-layout">
        <section>
          <SkeletonSectionTitle />
          <div className="context-room-skeleton-grid context-room-skeleton-recommendations">
            {Array.from({ length: 2 }, (_, index) => <SkeletonCard variant="recommendation" key={index} />)}
          </div>
        </section>

        <section>
          <div className="context-room-skeleton-toolbar" aria-hidden="true">
            <div className="context-room-skeleton-my-title">
              <SkeletonSectionTitle compact />
              <span className="context-room-skeleton-actions">
                <i className="context-room-skeleton-block" />
                <i className="context-room-skeleton-block" />
              </span>
            </div>
            <span className="context-room-skeleton-block context-room-skeleton-search" />
          </div>
          <div className="context-room-skeleton-grid">
            {Array.from({ length: 6 }, (_, index) => <SkeletonCard variant="room" key={index} />)}
          </div>
          <span className="context-room-skeleton-block context-room-skeleton-show-all" aria-hidden="true" />
        </section>

        <section>
          <SkeletonSectionTitle />
          <div className="context-room-skeleton-graph-frame" aria-hidden="true">
            <div className="context-room-skeleton-block context-room-skeleton-graph">
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <i className="context-room-skeleton-block" />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
