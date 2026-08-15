import './ContextRoomHomeSkeleton.css'

function SkeletonLine({ width }: { width: string }) {
  return <span className="context-room-skeleton-block context-room-skeleton-line" style={{ width }} />
}

function SkeletonCard() {
  return (
    <div className="context-room-skeleton-card" aria-hidden="true">
      <span className="context-room-skeleton-block context-room-skeleton-icon" />
      <span className="context-room-skeleton-card-copy">
        <SkeletonLine width="42%" />
        <SkeletonLine width="78%" />
      </span>
      <span className="context-room-skeleton-block context-room-skeleton-chip" />
    </div>
  )
}

function SkeletonSectionTitle() {
  return (
    <div className="context-room-skeleton-title" aria-hidden="true">
      <SkeletonLine width="34px" />
      <SkeletonLine width="104px" />
    </div>
  )
}

export function ContextRoomHomeSkeleton() {
  return (
    <div className="context-room-home-loading" role="status" aria-label="正在加载 Context Room">
      <span className="context-room-skeleton-status">正在加载 Context Room</span>
      <div className="context-room-home-loading-layout">
        <section>
          <SkeletonSectionTitle />
          <div className="context-room-skeleton-grid context-room-skeleton-recommendations">
            {Array.from({ length: 4 }, (_, index) => <SkeletonCard key={index} />)}
          </div>
        </section>

        <section>
          <div className="context-room-skeleton-toolbar" aria-hidden="true">
            <SkeletonSectionTitle />
            <span className="context-room-skeleton-block context-room-skeleton-search" />
          </div>
          <div className="context-room-skeleton-grid">
            {Array.from({ length: 6 }, (_, index) => <SkeletonCard key={index} />)}
          </div>
        </section>

        <section>
          <SkeletonSectionTitle />
          <div className="context-room-skeleton-block context-room-skeleton-graph" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </section>
      </div>
    </div>
  )
}
