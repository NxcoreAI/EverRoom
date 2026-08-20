import { ArrowLeft, Layers3, Search } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from '../../../../i18n/LocaleContext'

import type { ContextRoomRecord } from '../types'
import { RoomCard } from './RoomCard'
import { RoomLifecycleDialogs } from './RoomDialogs'

const ROOM_BATCH_SIZE = 12

export function AllRoomsView({
  rooms,
  onBack,
  onOpenDetail,
  onRenameRoom,
  onDeleteRoom,
  onRestoreRoom,
}: {
  rooms: ContextRoomRecord[]
  onBack: () => void
  onOpenDetail: (roomId: string) => void
  onRenameRoom: (roomId: string, name: string) => void
  onDeleteRoom: (roomId: string) => void
  onRestoreRoom: (roomId: string) => void
}) {
  const { t } = useLocale()
  const scrollRootRef = useRef<HTMLElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [visibleCount, setVisibleCount] = useState(ROOM_BATCH_SIZE)
  const [renameRoom, setRenameRoom] = useState<ContextRoomRecord | null>(null)
  const [deleteRoom, setDeleteRoom] = useState<ContextRoomRecord | null>(null)
  const [recentlyDeleted, setRecentlyDeleted] = useState<ContextRoomRecord | null>(null)

  const filteredRooms = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase()
    return normalized
      ? rooms.filter((room) => room.title.toLowerCase().includes(normalized))
      : rooms
  }, [deferredQuery, rooms])
  const renderedRooms = filteredRooms.slice(0, visibleCount)
  const hasMore = visibleCount < filteredRooms.length

  useEffect(() => {
    setVisibleCount(ROOM_BATCH_SIZE)
    scrollRootRef.current?.scrollTo({ top: 0 })
  }, [deferredQuery])

  useEffect(() => {
    const target = loadMoreRef.current
    const root = scrollRootRef.current
    if (!target || !root || !hasMore) return undefined
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return
      setVisibleCount((current) => Math.min(current + ROOM_BATCH_SIZE, filteredRooms.length))
    }, { root, rootMargin: '180px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [filteredRooms.length, hasMore])

  return (
    <div className="context-room-app">
      <main ref={scrollRootRef} className="context-room-all" data-testid="context-room-all-page">
        <div className="context-room-all-layout">
          <header className="context-room-all-header">
            <button type="button" className="context-room-all-back" onClick={onBack} aria-label={t('contextRoom:allRooms.backToContextRoomHome')} title={t('contextRoom:allRooms.back')}>
              <ArrowLeft aria-hidden="true" />
            </button>
            <div>
              <span>Context Room</span>
              <h1>{t('contextRoom:allRooms.allRooms')}</h1>
              <p>{t('contextRoom:allRooms.countRooms', { count: rooms.length })}</p>
            </div>
            <label className="context-room-home-search context-room-all-search">
              <Search aria-hidden="true" />
              <input
                type="search"
                aria-label={t('contextRoom:allRooms.searchAllRooms')}
                placeholder={t('contextRoom:allRooms.searchAllRooms')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </header>

          <section aria-label={t('contextRoom:allRooms.allRooms')}>
            <div className="context-room-home-grid context-room-all-grid" data-testid="context-room-all-grid">
              {renderedRooms.map((room) => (
                <RoomCard
                  key={room.id}
                  room={room}
                  onOpen={onOpenDetail}
                  onRename={() => setRenameRoom(room)}
                  onDelete={() => setDeleteRoom(room)}
                />
              ))}
              {!filteredRooms.length ? (
                <div className="context-room-home-empty">
                  <Layers3 aria-hidden="true" />
                  <h3>{t(rooms.length ? 'contextRoom:allRooms.noMatchingRooms' : 'contextRoom:allRooms.noRoomsYet')}</h3>
                  <p>{t(rooms.length ? 'contextRoom:allRooms.tryAnotherSearchTerm' : 'contextRoom:allRooms.createYourFirstRoomFromTheContextRoom')}</p>
                </div>
              ) : null}
            </div>
            <div ref={loadMoreRef} className="context-room-all-load-more" aria-live="polite">
              {hasMore ? (
                <>
                  <span className="context-room-all-loading-card" aria-hidden="true" />
                  <span className="context-room-all-loading-card" aria-hidden="true" />
                  <span className="context-room-all-loading-card" aria-hidden="true" />
                  <span className="context-room-visually-hidden">{t('contextRoom:allRooms.loadingMoreRooms')}</span>
                </>
              ) : filteredRooms.length ? <span>{t('contextRoom:allRooms.allCountRoomsDisplayed', { count: filteredRooms.length })}</span> : null}
            </div>
          </section>
        </div>
      </main>

      <RoomLifecycleDialogs
        renameRoom={renameRoom}
        deleteRoom={deleteRoom}
        recentlyDeleted={recentlyDeleted}
        onRenameRoomChange={setRenameRoom}
        onDeleteRoomChange={setDeleteRoom}
        onRecentlyDeletedChange={setRecentlyDeleted}
        onRenameRoom={onRenameRoom}
        onDeleteRoom={onDeleteRoom}
        onRestoreRoom={onRestoreRoom}
      />
    </div>
  )
}
