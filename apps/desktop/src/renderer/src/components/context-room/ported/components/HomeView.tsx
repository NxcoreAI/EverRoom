import {
  ArrowRight,
  FileText,
  Layers3,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useLocale } from '../../../../i18n/LocaleContext';

import type { ContextRoomRecord } from '../types';
import { ReferenceDialog } from './shared';
import { KnowledgePendingPanel } from './KnowledgePendingPanel';
import { RoomCard } from './RoomCard';
import { RoomForm, RoomLifecycleDialogs, type DraftRoom } from './RoomDialogs';
import { RoomGraphCanvas, type RoomGraphCanvasHandle } from './RoomGraphCanvas';
import {
  RoomRecommendationDialog,
  RoomRecommendations,
  type RoomRecommendation,
  type RoomRecommendationSource,
} from './RoomRecommendations';
import { roomKindIcon, roomKindTone } from './utils';

function RoomGraph({
  rooms,
  onOpen,
}: {
  rooms: ContextRoomRecord[];
  onOpen: (id: string) => void;
}) {
  const { t } = useLocale();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const graphRef = useRef<RoomGraphCanvasHandle>(null);
  const selected = rooms.find((room) => room.id === selectedId);

  return (
    <section className="context-room-home-section context-room-home-graph-section">
      <div className="context-room-home-section-title">
        <span>{t('关系')}</span>
        <h2>{t('Room 关系图谱')}</h2>
      </div>
      <div className={`context-room-room-graph-layout${selected ? ' is-selected' : ''}`}>
        <div className="context-room-room-graph-canvas">
          <RoomGraphCanvas
            ref={graphRef}
            rooms={rooms}
            selectedId={selectedId}
            onSelectRoom={setSelectedId}
            onOpenRoom={onOpen}
          />
          <button
            type="button"
            className="context-room-graph-fit-button"
            onClick={() => void graphRef.current?.fitView()}
          >
            {t('适应画布')}
          </button>
        </div>
        {selected ? (
          <aside className="context-room-room-graph-drawer">
            <button
              type="button"
              aria-label={t('关闭 Room 关系详情')}
              onClick={() => setSelectedId(null)}
            >
              <X aria-hidden="true" />
            </button>
            <div className="context-room-graph-drawer-title">
              <span
                className="context-room-home-card-icon"
                data-icon-tone={roomKindTone(selected.kind)}
              >
                {(() => {
                  const Icon = roomKindIcon(selected.kind);
                  return <Icon aria-hidden="true" />;
                })()}
              </span>
              <div>
                <h3>{selected.title}</h3>
                <p>{selected.brief.background}</p>
              </div>
            </div>
            <div className="context-room-graph-materials">
              <header>
                <span>{t('相关资料')}</span>
                <b>{selected.materials.length + selected.fileItems.length}</b>
              </header>
              {[...selected.materials.slice(0, 3), ...selected.fileItems.slice(0, 2)].map(
                (item) => {
                  const name = 'title' in item ? item.title : item.name;
                  const time = item.time;
                  return (
                    <div key={'id' in item ? item.id : name}>
                      <FileText aria-hidden="true" />
                      <span>
                        <b>{name}</b>
                        <small>{time}</small>
                      </span>
                    </div>
                  );
                }
              )}
            </div>
            <button
              type="button"
              className="context-room-primary"
              onClick={() => onOpen(selected.id)}
            >
              {t('打开 Room')}
            </button>
          </aside>
        ) : null}
      </div>
    </section>
  );
}

export function HomeView({
  rooms,
  deletedRooms,
  onCreateRoom,
  onRenameRoom,
  onDeleteRoom,
  onRestoreRoom,
  onOpenRecommendationSource,
  onOpenDetail,
  onShowAll,
}: {
  rooms: ContextRoomRecord[];
  deletedRooms: ContextRoomRecord[];
  onCreateRoom: (draft: DraftRoom) => void;
  onRenameRoom: (roomId: string, name: string) => void;
  onDeleteRoom: (roomId: string) => void;
  onRestoreRoom: (roomId: string) => void;
  onOpenRecommendationSource: (source: RoomRecommendationSource) => void;
  onOpenDetail: (roomId: string) => void;
  onShowAll: () => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState('');
  const [recommendation, setRecommendation] = useState<RoomRecommendation | null>(null);
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [renameRoom, setRenameRoom] = useState<ContextRoomRecord | null>(null);
  const [deleteRoom, setDeleteRoom] = useState<ContextRoomRecord | null>(null);
  const [deletedRoomsOpen, setDeletedRoomsOpen] = useState(false);
  const [recentlyDeleted, setRecentlyDeleted] = useState<ContextRoomRecord | null>(null);
  const visibleRooms = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? rooms.filter((room) => room.title.toLowerCase().includes(normalized))
      : rooms;
  }, [query, rooms]);
  const homeRooms = query.trim() ? visibleRooms : visibleRooms.slice(0, 6);

  return (
    <div className="context-room-app">
      <main className="context-room-home" data-testid="context-room-page">
        <div className="context-room-home-layout">
          <RoomRecommendations onSelect={setRecommendation} />

          <section className="context-room-home-section">
            <div className="context-room-my-toolbar" data-testid="context-room-list-toolbar">
              <div className="context-room-my-title">
                <div className="context-room-home-section-title">
                  <span>{t('我的')}</span>
                  <h2>{t('我的 Room')}</h2>
                </div>
                <div className="context-room-my-actions" aria-label={t('Room 操作')}>
                  <button
                    type="button"
                    aria-label={t('新建 Room')}
                    title={t('新建 Room')}
                    className="context-room-add-room"
                    onClick={() => setNewRoomOpen(true)}
                  >
                    <Plus aria-hidden="true" />
                  </button>
                  {deletedRooms.length ? (
                    <button
                      type="button"
                      aria-label={t('已删除 Room {count} 项', { count: deletedRooms.length })}
                      title={t('已删除 Room')}
                      className="context-room-add-room"
                      onClick={() => setDeletedRoomsOpen(true)}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>
              <label className="context-room-home-search">
                <Search aria-hidden="true" />
                <input
                  type="search"
                  aria-label={t('搜索我的 Room')}
                  placeholder={t('搜索我的 Room')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            </div>
            <div className="context-room-home-grid" data-testid="context-room-grid">
              {homeRooms.map((room) => (
                <RoomCard
                  key={room.id}
                  room={room}
                  onOpen={onOpenDetail}
                  onRename={() => setRenameRoom(room)}
                  onDelete={() => setDeleteRoom(room)}
                />
              ))}
              {!visibleRooms.length ? (
                <div className="context-room-home-empty">
                  <Layers3 aria-hidden="true" />
                  <h3>{t('没有匹配的 Room')}</h3>
                  <p>{t('调整搜索关键词，或创建一个新的 Context Room。')}</p>
                </div>
              ) : null}
            </div>
            {!query.trim() && rooms.length ? (
              <button type="button" className="context-room-show-all" onClick={onShowAll}>
                <span>{t('显示全部 Room')}</span>
                <small>{rooms.length}</small>
                <ArrowRight aria-hidden="true" />
              </button>
            ) : null}
          </section>

          <KnowledgePendingPanel />

          <RoomGraph rooms={rooms} onOpen={onOpenDetail} />
        </div>
      </main>

      <ReferenceDialog
        open={Boolean(recommendation)}
        onOpenChange={(open) => !open && setRecommendation(null)}
        title={t('推荐 Room 详情')}
      >
        {recommendation ? (
          <RoomRecommendationDialog
            recommendation={recommendation}
            onClose={() => setRecommendation(null)}
            onOpenSource={(source) => {
              setRecommendation(null);
              onOpenRecommendationSource(source);
            }}
            onCreate={(draft) => {
              onCreateRoom(draft);
              setRecommendation(null);
            }}
          />
        ) : null}
      </ReferenceDialog>

      <ReferenceDialog open={newRoomOpen} onOpenChange={setNewRoomOpen} title={t('新建 Context Room')}>
        <RoomForm
          title={t('新建 Context Room')}
          submitLabel={t('创建 Room')}
          onCancel={() => setNewRoomOpen(false)}
          onSubmit={(draft) => {
            onCreateRoom(draft);
            setNewRoomOpen(false);
          }}
        />
      </ReferenceDialog>
      <ReferenceDialog
        open={deletedRoomsOpen}
        onOpenChange={setDeletedRoomsOpen}
        title={t('已删除 Room')}
      >
        <div className="context-room-deleted-dialog">
          <header>
            <div>
              <span>{t('管理')}</span>
              <h2>{t('已删除 Room')}</h2>
            </div>
          </header>
          <div className="context-room-deleted-list">
            {deletedRooms.map((room) => (
              <article key={room.id}>
                <span
                  className="context-room-home-card-icon"
                  data-icon-tone={roomKindTone(room.kind)}
                >
                  {(() => {
                    const Icon = roomKindIcon(room.kind);
                    return <Icon aria-hidden="true" />;
                  })()}
                </span>
                <span>
                  <b>{room.title}</b>
                  <small>
                    {t(room.kind)} · {t('{count} 项资料', { count: room.materials.length + room.fileItems.length })}
                  </small>
                </span>
                <button
                  type="button"
                  className="context-room-secondary"
                  onClick={() => onRestoreRoom(room.id)}
                >
                  <RotateCcw aria-hidden="true" />
                  {t('恢复')}
                </button>
              </article>
            ))}
          </div>
        </div>
      </ReferenceDialog>
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
  );
}
