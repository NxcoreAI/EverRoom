import {
  ArrowRight,
  FileText,
  Folder,
  Layers3,
  Mail,
  Mic,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import { CONTEXT_ROOM_RECOMMENDATIONS } from '../data';
import type { ContextRoomKind, ContextRoomRecommendation, ContextRoomRecord } from '../types';
import { ActionConfirmDialog, ReferenceDialog } from './shared';
import { KnowledgePendingPanel } from './KnowledgePendingPanel';
import { RoomCard } from './RoomCard';
import { RoomGraphCanvas, type RoomGraphCanvasHandle } from './RoomGraphCanvas';
import { roomKindIcon, roomKindTone } from './utils';

type DraftRoom = { name: string; kind: ContextRoomKind; summary: string };

function recommendationSourceIcon(type: string) {
  if (type === '邮件') return Mail;
  if (type === '文件') return Folder;
  return Mic;
}

function recommendationSourceTone(type: string) {
  if (type === '邮件') return 'communication';
  if (type === '文件') return 'document';
  return 'calendar';
}

function RecommendationDialog({
  recommendation,
  onClose,
  onCreate,
  onOpenSource,
}: {
  recommendation: ContextRoomRecommendation;
  onClose: () => void;
  onCreate: (draft: DraftRoom) => void;
  onOpenSource: (source: ContextRoomRecommendation['sources'][number]) => void;
}) {
  const anchor = recommendation.anchorEntity;
  return (
    <div className="context-room-recommendation-dialog">
      <header>
        <div>
          <span>推荐创建 Room：{recommendation.name}</span>
          <h2>{anchor?.name ?? recommendation.name}</h2>
        </div>
      </header>
      <p>{anchor?.description ?? recommendation.reason}</p>
      <div className="context-room-recommendation-stats">
        <div>
          <b>{recommendation.factCount ?? recommendation.dataCount}</b>
          <span>事实数量</span>
        </div>
        <div>
          <b>{recommendation.dataCount}</b>
          <span>资料数</span>
        </div>
      </div>
      <section>
        <h3>相关资料 ({recommendation.sources.length})</h3>
        <div className="context-room-recommendation-source-list">
          {recommendation.sources.map((source) => {
            const Icon = recommendationSourceIcon(source.type);
            return (
              <button
                type="button"
                key={`${source.type}-${source.name}`}
                disabled={!source.roomId || !source.objectId}
                title={source.objectId ? `打开${source.type}` : '该资料暂未接入当前工作区'}
                onClick={() => onOpenSource(source)}
              >
                <span data-icon-tone={recommendationSourceTone(source.type)}>
                  <Icon aria-hidden="true" />
                  {source.type}
                </span>
                <b>{source.name}</b>
              </button>
            );
          })}
        </div>
      </section>
      <footer>
        <button type="button" className="context-room-secondary" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="context-room-primary"
          onClick={() =>
            onCreate({
              name: recommendation.name,
              kind: recommendation.kind,
              summary: anchor?.description ?? recommendation.reason,
            })
          }
        >
          确认创建
          <ArrowRight aria-hidden="true" />
        </button>
      </footer>
    </div>
  );
}

function RoomForm({
  title,
  initial,
  submitLabel,
  renameOnly = false,
  onCancel,
  onSubmit,
}: {
  title: string;
  initial?: DraftRoom;
  submitLabel: string;
  renameOnly?: boolean;
  onCancel?: () => void;
  onSubmit: (draft: DraftRoom) => void;
}) {
  return (
    <form
      className="context-room-room-form"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        const name = values.get('name');
        const kind = values.get('kind');
        const summary = values.get('summary');
        onSubmit({
          name: typeof name === 'string' ? name.trim() : '',
          kind: (typeof kind === 'string' ? kind : '项目') as ContextRoomKind,
          summary: typeof summary === 'string' ? summary.trim() : '',
        });
      }}
    >
      <h2>{title}</h2>
      <label>
        <span>名称</span>
        <input name="name" defaultValue={initial?.name} required maxLength={40} autoFocus />
      </label>
      {renameOnly ? (
        <input type="hidden" name="kind" value={initial?.kind ?? '项目'} />
      ) : (
        <label>
          <span>类型</span>
          <select name="kind" defaultValue={initial?.kind ?? '项目'}>
            {(['项目', '主题', '人物', '长期目标', '议题', '事件'] as ContextRoomKind[]).map(
              (kind) => (
                <option key={kind}>{kind}</option>
              )
            )}
          </select>
        </label>
      )}
      {renameOnly ? (
        <input type="hidden" name="summary" value={initial?.summary ?? ''} />
      ) : (
        <label>
          <span>初始说明</span>
          <textarea
            name="summary"
            rows={4}
            defaultValue={initial?.summary}
            placeholder="描述目标、范围或需要聚合的资料"
          />
        </label>
      )}
      <footer>
        {onCancel ? (
          <button type="button" className="context-room-ghost" onClick={onCancel}>
            取消
          </button>
        ) : null}
        <button type="submit" className="context-room-primary">
          {submitLabel}
        </button>
      </footer>
    </form>
  );
}

function RoomGraph({
  rooms,
  onOpen,
}: {
  rooms: ContextRoomRecord[];
  onOpen: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const graphRef = useRef<RoomGraphCanvasHandle>(null);
  const selected = rooms.find((room) => room.id === selectedId);

  return (
    <section className="context-room-home-section context-room-home-graph-section">
      <div className="context-room-home-section-title">
        <span>关系</span>
        <h2>Room 关系图谱</h2>
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
            适应画布
          </button>
        </div>
        {selected ? (
          <aside className="context-room-room-graph-drawer">
            <button
              type="button"
              aria-label="关闭 Room 关系详情"
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
                <span>相关资料</span>
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
              打开 Room
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
}: {
  rooms: ContextRoomRecord[];
  deletedRooms: ContextRoomRecord[];
  onCreateRoom: (draft: DraftRoom) => void;
  onRenameRoom: (roomId: string, name: string) => void;
  onDeleteRoom: (roomId: string) => void;
  onRestoreRoom: (roomId: string) => void;
  onOpenRecommendationSource: (source: ContextRoomRecommendation['sources'][number]) => void;
  onOpenDetail: (roomId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [recommendation, setRecommendation] = useState<ContextRoomRecommendation | null>(null);
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

  return (
    <div className="context-room-app">
      <main className="context-room-home" data-testid="context-room-page">
        <div className="context-room-home-layout">
          {CONTEXT_ROOM_RECOMMENDATIONS.length > 0 ? (
          <section className="context-room-home-section" data-testid="context-room-recommendations">
            <div className="context-room-home-section-title">
              <span>推荐</span>
              <h2>推荐的 Room</h2>
            </div>
            <div className="context-room-home-grid context-room-recommendation-grid">
              {CONTEXT_ROOM_RECOMMENDATIONS.map((item) => {
                const Icon = roomKindIcon(item.kind);
                return (
                  <button
                    type="button"
                    className="context-room-home-card context-room-recommendation-card"
                    key={item.id}
                    onClick={() => setRecommendation(item)}
                  >
                    <span
                      className="context-room-home-card-icon"
                      data-icon-tone={roomKindTone(item.kind)}
                    >
                      <Icon aria-hidden="true" />
                    </span>
                    <span className="context-room-home-card-body">
                      <strong>{item.name}</strong>
                      <span className="context-room-home-card-brief">{item.reason}</span>
                    </span>
                    <span
                      className="context-room-recommendation-count"
                      title={`相关资料 ${String(item.dataCount)} 份`}
                    >
                      <Layers3 aria-hidden="true" />
                      <b>{item.dataCount}</b>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          ) : null}

          <section className="context-room-home-section">
            <div className="context-room-my-toolbar" data-testid="context-room-list-toolbar">
              <div className="context-room-my-title">
                <div className="context-room-home-section-title">
                  <span>我的</span>
                  <h2>我的 Room</h2>
                </div>
                <div className="context-room-my-actions" aria-label="Room 操作">
                  <button
                    type="button"
                    aria-label="新建 Room"
                    title="新建 Room"
                    className="context-room-add-room"
                    onClick={() => setNewRoomOpen(true)}
                  >
                    <Plus aria-hidden="true" />
                  </button>
                  {deletedRooms.length ? (
                    <button
                      type="button"
                      aria-label={`已删除 Room ${String(deletedRooms.length)} 项`}
                      title="已删除 Room"
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
                  aria-label="搜索我的 Room"
                  placeholder="搜索我的 Room"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            </div>
            <div className="context-room-home-grid" data-testid="context-room-grid">
              {visibleRooms.map((room) => (
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
                  <h3>没有匹配的 Room</h3>
                  <p>调整搜索关键词，或创建一个新的 Context Room。</p>
                </div>
              ) : null}
            </div>
          </section>

          <KnowledgePendingPanel />

          <RoomGraph rooms={rooms} onOpen={onOpenDetail} />
        </div>
      </main>

      <ReferenceDialog
        open={Boolean(recommendation)}
        onOpenChange={(open) => !open && setRecommendation(null)}
        title="推荐 Room 详情"
      >
        {recommendation ? (
          <RecommendationDialog
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
      <ReferenceDialog open={newRoomOpen} onOpenChange={setNewRoomOpen} title="新建 Context Room">
        <RoomForm
          title="新建 Context Room"
          submitLabel="创建 Room"
          onCancel={() => setNewRoomOpen(false)}
          onSubmit={(draft) => {
            onCreateRoom(draft);
            setNewRoomOpen(false);
          }}
        />
      </ReferenceDialog>
      <ReferenceDialog
        open={Boolean(renameRoom)}
        onOpenChange={(open) => !open && setRenameRoom(null)}
        title="重命名 Room"
      >
        {renameRoom ? (
          <RoomForm
            title={`为「${renameRoom.title}」设置新名称`}
            submitLabel="保存"
            renameOnly
            onCancel={() => setRenameRoom(null)}
            initial={{
              name: renameRoom.title,
              kind: renameRoom.kind,
              summary: renameRoom.brief.background,
            }}
            onSubmit={(draft) => {
              onRenameRoom(renameRoom.id, draft.name);
              setRenameRoom(null);
            }}
          />
        ) : null}
      </ReferenceDialog>
      <ActionConfirmDialog
        open={Boolean(deleteRoom)}
        onOpenChange={(open) => !open && setDeleteRoom(null)}
        title="删除 Context Room"
        summary={deleteRoom ? `“${deleteRoom.title}”将移至已删除 Room。` : ''}
        rows={
          deleteRoom
            ? [
                { label: 'Room 类型', value: deleteRoom.kind },
                {
                  label: '资料范围',
                  value: `文档 ${String(deleteRoom.stats.docs)} · 邮件 ${String(deleteRoom.stats.mails)} · 会议 ${String(deleteRoom.stats.meetings)}`,
                },
              ]
            : []
        }
        risk="资料本体不会被删除，但 Agent 不再以此 Room 作为上下文边界，可在已删除 Room 中恢复。"
        confirmLabel="删除"
        danger
        onConfirm={() => {
          if (!deleteRoom) return;
          onDeleteRoom(deleteRoom.id);
          setRecentlyDeleted(deleteRoom);
          setDeleteRoom(null);
        }}
      />
      <ReferenceDialog
        open={deletedRoomsOpen}
        onOpenChange={setDeletedRoomsOpen}
        title="已删除 Room"
      >
        <div className="context-room-deleted-dialog">
          <header>
            <div>
              <span>管理</span>
              <h2>已删除 Room</h2>
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
                    {room.kind} · {room.materials.length + room.fileItems.length} 项资料
                  </small>
                </span>
                <button
                  type="button"
                  className="context-room-secondary"
                  onClick={() => onRestoreRoom(room.id)}
                >
                  <RotateCcw aria-hidden="true" />
                  恢复
                </button>
              </article>
            ))}
          </div>
        </div>
      </ReferenceDialog>
      {recentlyDeleted ? (
        <div className="context-room-undo" role="status">
          <span>已删除“{recentlyDeleted.title}”</span>
          <button
            type="button"
            onClick={() => {
              onRestoreRoom(recentlyDeleted.id);
              setRecentlyDeleted(null);
            }}
          >
            <RotateCcw aria-hidden="true" />
            撤销
          </button>
          <button type="button" aria-label="关闭撤销提示" onClick={() => setRecentlyDeleted(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
