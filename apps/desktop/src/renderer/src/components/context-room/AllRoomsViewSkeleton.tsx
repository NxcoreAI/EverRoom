import { ArrowLeft } from 'lucide-react'

import './ContextRoomHomeSkeleton.css'

import { useLocale } from '../../i18n/LocaleContext'

export function AllRoomsViewSkeleton() {
  const { t } = useLocale()
  return (
    <div className="context-room-all-skeleton" role="status" aria-label={t('contextRoom:allRoomsViewSkeleton.loadingAllRooms')}>
      <div className="context-room-all-skeleton-layout">
        <header>
          <span className="context-room-all-skeleton-back"><ArrowLeft aria-hidden="true" /></span>
          <div className="context-room-all-skeleton-heading">
            <span className="context-room-skeleton-block" />
            <span className="context-room-skeleton-block" />
            <span className="context-room-skeleton-block" />
          </div>
          <span className="context-room-skeleton-block context-room-all-skeleton-search" />
        </header>
        <div className="context-room-skeleton-grid context-room-all-skeleton-grid">
          {Array.from({ length: 12 }, (_, index) => (
            <div className="context-room-skeleton-card" aria-hidden="true" key={index}>
              <span className="context-room-skeleton-block context-room-skeleton-icon" />
              <span className="context-room-skeleton-card-copy">
                <span className="context-room-skeleton-block context-room-skeleton-line" style={{ width: '42%' }} />
                <span className="context-room-skeleton-block context-room-skeleton-line" style={{ width: '78%' }} />
              </span>
              <span className="context-room-skeleton-block context-room-skeleton-chip" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
