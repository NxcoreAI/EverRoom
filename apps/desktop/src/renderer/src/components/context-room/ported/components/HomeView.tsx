import {
  ArrowRight,
  GitMerge,
  Layers3,
  Link2,
  Maximize2,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from '../../../../i18n/LocaleContext';
import obsidianLogo from '../../../../assets/obsidian.svg';

import type { ContextRoomRecord } from '../types';
import { localizedUiText, uiText } from '../adapters';
import { ReferenceDialog } from './shared';
import { KnowledgePendingPanel } from './KnowledgePendingPanel';
import { RoomCard } from './RoomCard';
import { RoomCreationStudio } from './RoomCreationStudio';
import { RoomLifecycleDialogs } from './RoomDialogs';
import { isMergeRecommendationCandidate, RoomDuplicateCenter } from './RoomDuplicateCenter';
import { RoomGraphCanvas, type RoomGraphCanvasHandle } from './RoomGraphCanvas';
import { RoomNodeInspector } from './RoomGraphInspector';
import { CreateRoomRelationDialog, RoomRelationInspector } from './RoomRelationControls';
import { useRoomRelationGraph } from '../hooks/useRoomRelationGraph';
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
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);
  const [relationType, setRelationType] = useState('all');
  const [strength, setStrength] = useState('all');
  const [graphQuery, setGraphQuery] = useState('');
  const [showIsolated, setShowIsolated] = useState(true);
  const [visibility, setVisibility] = useState<'active' | 'hidden'>('active');
  const [createRelationOpen, setCreateRelationOpen] = useState(false);
  const graphRef = useRef<RoomGraphCanvasHandle>(null);
  const { error, graph, loading, reload } = useRoomRelationGraph(null, visibility);
  const filteredEdges = useMemo(() => (graph?.edges ?? []).filter((edge) => {
    if (strength !== 'all' && edge.strength !== strength) return false;
    if (relationType === 'manual') return edge.origin !== 'auto';
    return relationType === 'all' || edge.type === relationType;
  }), [graph?.edges, relationType, strength]);
  const connectedIds = useMemo(() => new Set(filteredEdges.flatMap((edge) => [edge.sourceRoomId, edge.targetRoomId])), [filteredEdges]);
  const graphRooms = useMemo(() => {
    const normalized = graphQuery.trim().toLowerCase();
    return rooms.filter((room) => {
      if (!showIsolated && !connectedIds.has(room.id)) return false;
      return !normalized || room.title.toLowerCase().includes(normalized);
    });
  }, [connectedIds, graphQuery, rooms, showIsolated]);
  const graphRoomIds = useMemo(() => new Set(graphRooms.map((room) => room.id)), [graphRooms]);
  const visibleEdges = useMemo(() => filteredEdges.filter((edge) => (
    graphRoomIds.has(edge.sourceRoomId) && graphRoomIds.has(edge.targetRoomId)
  )), [filteredEdges, graphRoomIds]);
  const selected = rooms.find((room) => room.id === selectedId);
  const selectedRelation = (graph?.edges ?? []).find((edge) => edge.id === selectedRelationId) ?? null;

  return (
    <section className="context-room-home-section context-room-home-graph-section">
      <div className="context-room-home-section-title context-room-graph-heading">
        <div><span>{t('contextRoom:home.relations')}</span><h2>{t('contextRoom:home.roomRelationshipGraph')}</h2></div>
        <div className="context-room-graph-index-state" data-status={error ? 'degraded' : graph?.indexing.status ?? 'building'}>
          {error
            ? t('contextRoom:relations.indexDegraded')
            : graph?.indexing.status === 'building'
              ? t('contextRoom:relations.indexBuilding', { count: graph.indexing.pendingSources })
              : graph?.indexing.status === 'degraded'
                ? t('contextRoom:relations.indexDegraded')
                : t('contextRoom:relations.indexReady')}
        </div>
      </div>
      <div className="context-room-room-graph-toolbar">
        <label className="context-room-home-search">
          <Search aria-hidden="true" />
          <input type="search" value={graphQuery} placeholder={t('contextRoom:relations.searchRooms')} onChange={(event) => setGraphQuery(event.target.value)} />
        </label>
        <select aria-label={t('contextRoom:relations.filterType')} value={relationType} onChange={(event) => setRelationType(event.target.value)}>
          <option value="all">{t('contextRoom:relations.allTypes')}</option>
          <option value="shared_evidence">{t('contextRoom:relations.type.shared_evidence')}</option>
          <option value="shared_entity">{t('contextRoom:relations.type.shared_entity')}</option>
          <option value="mixed">{t('contextRoom:relations.type.mixed')}</option>
          <option value="manual">{t('contextRoom:relations.manualRelations')}</option>
        </select>
        <select aria-label={t('contextRoom:relations.filterStrength')} value={strength} onChange={(event) => setStrength(event.target.value)}>
          <option value="all">{t('contextRoom:relations.allStrengths')}</option>
          <option value="weak">{t('contextRoom:relations.strength.weak')}</option>
          <option value="medium">{t('contextRoom:relations.strength.medium')}</option>
          <option value="strong">{t('contextRoom:relations.strength.strong')}</option>
        </select>
        <label className="context-room-graph-toggle"><input type="checkbox" checked={showIsolated} onChange={(event) => setShowIsolated(event.target.checked)} />{t('contextRoom:relations.showIsolated')}</label>
        <button type="button" className="context-room-graph-tool-button" aria-pressed={visibility === 'hidden'} onClick={() => setVisibility((current) => current === 'active' ? 'hidden' : 'active')}>
          {t(visibility === 'hidden' ? 'contextRoom:relations.showActive' : 'contextRoom:relations.showHidden')}
        </button>
        <button type="button" className="context-room-graph-tool-button" disabled={!selectedId} onClick={() => setCreateRelationOpen(true)}>
          <Link2 aria-hidden="true" />{t('contextRoom:relations.newRelation')}
        </button>
        <button type="button" className="context-room-graph-icon-button" aria-label={t('contextRoom:home.fitToCanvas')} title={t('contextRoom:home.fitToCanvas')} onClick={() => void graphRef.current?.fitView()}>
          <Maximize2 aria-hidden="true" />
        </button>
      </div>
      <div className={`context-room-room-graph-layout${selected || selectedRelation ? ' is-selected' : ''}`}>
        <div className="context-room-room-graph-canvas">
          {loading && !graph ? <div className="context-room-graph-state">{t('contextRoom:relations.loadingGraph')}</div> : (
            <RoomGraphCanvas
              ref={graphRef}
              rooms={graphRooms}
              relations={visibleEdges}
              selectedId={selectedId}
              selectedRelationId={selectedRelationId}
              onSelectRoom={(roomId) => { setSelectedRelationId(null); setSelectedId(roomId); }}
              onSelectRelation={(relationId) => { setSelectedId(null); setSelectedRelationId(relationId); }}
              onOpenRoom={onOpen}
            />
          )}
          {error ? <div className="context-room-graph-degraded">{t('contextRoom:relations.degradedNoSyntheticEdges')}</div> : null}
        </div>
        {selectedRelation ? (
          <RoomRelationInspector relation={selectedRelation} rooms={rooms} onClose={() => setSelectedRelationId(null)} onChanged={reload} />
        ) : selected ? (
          <RoomNodeInspector
            room={selected}
            onClose={() => setSelectedId(null)}
            onOpenRoom={onOpen}
          />
        ) : null}
      </div>
      <CreateRoomRelationDialog
        open={createRelationOpen}
        fromRoomId={selectedId}
        rooms={rooms}
        onOpenChange={setCreateRelationOpen}
        onCreated={async (relation) => { await reload(); setSelectedId(null); setSelectedRelationId(relation.id); }}
      />
    </section>
  );
}

export function HomeView({
  rooms,
  deletedRooms,
  onMountObsidian,
  onRenameRoom,
  onDeleteRoom,
  onRestoreRoom,
  onOpenDetail,
  onShowAll,
  onFocusAgent,
  onRefreshRooms,
  onManualMerge,
}: {
  rooms: ContextRoomRecord[];
  deletedRooms: ContextRoomRecord[];
  onMountObsidian: () => Promise<void>;
  onRenameRoom: (roomId: string, name: string) => void;
  onDeleteRoom: (roomId: string) => void;
  onRestoreRoom: (roomId: string) => void;
  onOpenDetail: (roomId: string) => void;
  onShowAll: () => void;
  onFocusAgent: () => void;
  onRefreshRooms: () => Promise<void>;
  /** 手动合并入口：对话框与预览由 PortedContextRoom 宿主。 */
  onManualMerge?: (room: ContextRoomRecord) => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState('');
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [duplicateCenterOpen, setDuplicateCenterOpen] = useState(false);
  const [duplicateCandidateCount, setDuplicateCandidateCount] = useState(0);
  const [renameRoom, setRenameRoom] = useState<ContextRoomRecord | null>(null);
  const [deleteRoom, setDeleteRoom] = useState<ContextRoomRecord | null>(null);
  const [deletedRoomsOpen, setDeletedRoomsOpen] = useState(false);
  const [recentlyDeleted, setRecentlyDeleted] = useState<ContextRoomRecord | null>(null);
  const visibleRooms = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matched = normalized
      ? rooms.filter((room) => room.title.toLowerCase().includes(normalized))
      : rooms;
    // 按更新时间倒序（与卡片上的“N 分钟前”同一时间戳）；缺时间戳的旧记录沉底。
    const updatedAtOf = (room: ContextRoomRecord) => {
      const time = room.updatedAt ? new Date(room.updatedAt).getTime() : Number.NaN;
      return Number.isFinite(time) ? time : 0;
    };
    return [...matched].sort((left, right) => updatedAtOf(right) - updatedAtOf(left));
  }, [query, rooms]);
  const homeRooms = query.trim() ? visibleRooms : visibleRooms.slice(0, 6);

  useEffect(() => {
    const api = window.nxcore?.contextRooms;
    if (!api) return;
    let active = true;
    const refreshDuplicateCount = () => {
      void api.listDuplicateCandidates('open').then((result) => {
        if (active) setDuplicateCandidateCount(result.items.filter(isMergeRecommendationCandidate).length);
      }).catch(() => {
        // The management dialog surfaces service errors when the user opens it.
      });
    };
    refreshDuplicateCount();
    // M2-A 红点收敛：网关候选重建（250ms 防抖 + LLM 同一性重评耗时数秒）后，
    // 一次性补拉永远存在时间窗——改为 15s 低频轮询收敛；弹窗内的
    // onCandidateCountChange 负责用户操作后的即时同步。
    const interval = window.setInterval(refreshDuplicateCount, 15_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [rooms]);

  return (
    <div className="context-room-app">
      <main className="context-room-home" data-testid="context-room-page">
        <div className="context-room-home-layout">
          <section className="context-room-home-section">
            <div className="context-room-my-toolbar" data-testid="context-room-list-toolbar">
              <div className="context-room-my-title">
                <div className="context-room-home-section-title">
                  <span>{t('contextRoom:home.mine')}</span>
                  <h2>{t('contextRoom:home.myRooms')}</h2>
                </div>
                <div className="context-room-my-actions" aria-label={t('contextRoom:home.roomActions')}>
                  <button type="button" aria-label={t('surface:obsidian.mount')} title={t('surface:obsidian.mount')} className="context-room-add-room" onClick={() => void onMountObsidian()}>
                    <img className="obsidian-app-icon" src={obsidianLogo} alt="" />
                  </button>
                  <button
                    type="button"
                    aria-label={duplicateCandidateCount > 0 ? t('contextRoom:home.duplicateRoomTooltipCount', { count: duplicateCandidateCount }) : t('contextRoom:home.duplicateRoomTooltip')}
                    title={duplicateCandidateCount > 0 ? t('contextRoom:home.duplicateRoomTooltipCountTitle', { count: duplicateCandidateCount }) : t('contextRoom:home.duplicateRoomTooltip')}
                    className="context-room-add-room context-room-duplicate-button"
                    onClick={() => setDuplicateCenterOpen(true)}
                  >
                    <GitMerge aria-hidden="true" />
                    {duplicateCandidateCount > 0 ? <span className="context-room-duplicate-alert" aria-hidden="true" /> : null}
                  </button>
                  {deletedRooms.length ? (
                    <button
                      type="button"
                      aria-label={t('contextRoom:home.countDeletedRooms', { count: deletedRooms.length })}
                      title={t('contextRoom:home.deletedRooms')}
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
                  aria-label={t('contextRoom:home.searchMyRooms')}
                  placeholder={t('contextRoom:home.searchMyRooms')}
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
                  onMerge={onManualMerge ? () => onManualMerge(room) : undefined}
                />
              ))}
              {!visibleRooms.length ? (
                <div className="context-room-home-empty">
                  <Layers3 aria-hidden="true" />
                  <h3>{t('contextRoom:home.noMatchingRooms')}</h3>
                  <p>{t('contextRoom:home.tryAnotherSearchTermOrCreateANew')}</p>
                </div>
              ) : null}
            </div>
            {!query.trim() && rooms.length ? (
              <button type="button" className="context-room-show-all" onClick={onShowAll}>
                <span>{t('contextRoom:home.showAllRooms')}</span>
                <small>{rooms.length}</small>
                <ArrowRight aria-hidden="true" />
              </button>
            ) : null}
          </section>

          <KnowledgePendingPanel onFocusAgent={onFocusAgent} onOpenCreateRoom={() => setNewRoomOpen(true)} />

          <RoomGraph rooms={rooms} onOpen={onOpenDetail} />
        </div>
      </main>

      <ReferenceDialog open={newRoomOpen} onOpenChange={setNewRoomOpen} title={t('contextRoom:home.newContextRoom')}>
        <RoomCreationStudio open={newRoomOpen} onOpenChange={setNewRoomOpen} />
      </ReferenceDialog>
      <RoomDuplicateCenter
        open={duplicateCenterOpen}
        onOpenChange={setDuplicateCenterOpen}
        onMerged={onRefreshRooms}
        onCandidateCountChange={setDuplicateCandidateCount}
      />
      <ReferenceDialog
        open={deletedRoomsOpen}
        onOpenChange={setDeletedRoomsOpen}
        title={t('contextRoom:home.deletedRooms')}
      >
        <div className="context-room-deleted-dialog">
          <header>
            <div>
              <span>{t('contextRoom:home.manage')}</span>
              <h2>{t('contextRoom:home.deletedRooms')}</h2>
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
                    {t(uiText(room.kind))} · {t('contextRoom:home.countResources', { count: room.materials.length + room.fileItems.length })}
                  </small>
                </span>
                <button
                  type="button"
                  className="context-room-secondary"
                  onClick={() => onRestoreRoom(room.id)}
                >
                  <RotateCcw aria-hidden="true" />
                  {t('contextRoom:home.resume')}
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
