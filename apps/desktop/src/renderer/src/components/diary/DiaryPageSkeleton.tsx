import './DiaryPageSkeleton.css'

const SKELETON_DAYS = Array.from({ length: 29 }, (_, index) => index)
const SKELETON_EVENTS = [0, 1, 2, 3]

export function DiaryPageSkeleton() {
  return (
    <div className="page diary-skeleton-page" aria-busy="true" aria-label="正在加载日记">
      <span className="diary-skeleton-status" role="status">正在加载日记</span>

      <header className="diary-skeleton-strip" aria-hidden="true">
        <div className="diary-skeleton-strip-inner">
          <div className="diary-skeleton-meta">
            <i className="diary-skeleton-block" />
            <i className="diary-skeleton-block" />
          </div>
          <div className="diary-skeleton-days">
            {SKELETON_DAYS.map((day) => (
              <span key={day}>
                <i className="diary-skeleton-block" />
                <b className="diary-skeleton-block" />
                <i className="diary-skeleton-block" />
              </span>
            ))}
          </div>
          <i className="diary-skeleton-calendar diary-skeleton-block" />
        </div>
        <i className="diary-skeleton-selection diary-skeleton-block" />
      </header>

      <main className="diary-skeleton-content" aria-hidden="true">
        <section className="diary-skeleton-intro">
          <i className="diary-skeleton-kicker diary-skeleton-block" />
          <i className="diary-skeleton-title diary-skeleton-block" />
          <i className="diary-skeleton-title diary-skeleton-title-short diary-skeleton-block" />
          <div className="diary-skeleton-copy">
            <i className="diary-skeleton-block" />
            <i className="diary-skeleton-block" />
          </div>
          <i className="diary-skeleton-note diary-skeleton-block" />
        </section>

        <aside className="diary-skeleton-reflection">
          <i className="diary-skeleton-reflection-heading diary-skeleton-block" />
          <i className="diary-skeleton-block" />
          <i className="diary-skeleton-block" />
        </aside>

        <section className="diary-skeleton-trace">
          <header>
            <span>
              <i className="diary-skeleton-eyebrow diary-skeleton-block" />
              <i className="diary-skeleton-section-title diary-skeleton-block" />
            </span>
            <i className="diary-skeleton-range diary-skeleton-block" />
          </header>

          <div className="diary-skeleton-timeline">
            {SKELETON_EVENTS.map((event) => (
              <article key={event} className="diary-skeleton-event">
                <i className="diary-skeleton-time diary-skeleton-block" />
                <div>
                  <span className="diary-skeleton-node diary-skeleton-block" />
                  <i className="diary-skeleton-event-label diary-skeleton-block" />
                  <i className="diary-skeleton-event-title diary-skeleton-block" />
                  <i className="diary-skeleton-event-copy diary-skeleton-block" />
                  <i className="diary-skeleton-event-copy diary-skeleton-event-copy-short diary-skeleton-block" />
                  {event === 1 ? <i className="diary-skeleton-media diary-skeleton-block" /> : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
