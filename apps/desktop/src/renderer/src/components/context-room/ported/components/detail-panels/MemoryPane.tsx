import {
  ChevronLeft,
  CircleDot,
  Link2,
  Maximize2,
  MessageSquareText,
  Network,
  Target,
  UserRound,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import { formatRoomUpdatedTime } from '../../roomUpdatedTime';
import type { ContextRoomRecord } from '../../types';
import { useRoomAppliedEntities } from '../../useRoomAppliedEntities';
import { localizedUiText, uiText } from '../../adapters';
import { EntityFactGraphCanvas } from '../EntityFactGraphCanvas';
import { createEntityFactGraphData, type EntityFactGraphFactNode } from '../entityFactGraphModel';
import { ActionConfirmDialog } from '../shared';
import type { WorkspaceObjectPreview } from './ObjectPreview';
import { PanelEmptyState } from './PanelEmptyState';

export function MemoryPane({
  room,
  onOpenMemory,
  onUpdateRoom,
  onOpenObject,
}: {
  room: ContextRoomRecord;
  onOpenMemory: (id: string) => void;
  onUpdateRoom: (updater: (room: ContextRoomRecord) => ContextRoomRecord) => void;
  /** 节点选中时同步推送右侧内容区展示详情（可选，独立渲染时不传）。 */
  onOpenObject?: (target: WorkspaceObjectPreview) => void;
}) {
  const { t, locale } = useLocale();
  const appliedMemory = useRoomAppliedEntities(room.id, room.updatedAt);
  const graphData = useMemo(
    () => createEntityFactGraphData(room, appliedMemory),
    [appliedMemory, room],
  );
  const [showFullGraph, setShowFullGraph] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => graphData.rootId);
  const [disableConfirmOpen, setDisableConfirmOpen] = useState(false);
  // 静态快照字段（手动建 Room 时 enrich 写入）或实时应用实体/事实任一有值即渲染图谱：
  // 自动创建的 Room 静态字段全空，数据只存在于结构化实体/事实表。
  const hasGraphContent = Boolean(
    room.memoryItems.length || room.people.length || room.graphEdges.length
    || appliedMemory?.entities.length
    || appliedMemory?.facts.length
  );
  // 选中图谱节点：更新内联详情卡，并同步推送右侧内容区展示完整详情。
  const selectNode = (nodeId: string) => {
    setSelectedId(nodeId);
    const node = graphData.nodes.find((candidate) => candidate.id === nodeId);
    if (node && onOpenObject) onOpenObject({ kind: 'graph-node', node });
  };

  useEffect(() => {
    setSelectedId(graphData.rootId);
    setDisableConfirmOpen(false);
  }, [graphData.rootId, room.id]);

  if (showFullGraph && hasGraphContent) {
    return (
      <div className="context-room-memory-pane">
        <header>
          <h2>{t('contextRoom:memory.roomMemory')}</h2>
          <button type="button" onClick={() => setShowFullGraph(false)}>
            <ChevronLeft aria-hidden="true" />
            {t('contextRoom:memory.backToEntitiesAndFacts')}
          </button>
        </header>
        <div className="context-room-memory-graph-stage context-room-memory-full-graph">
          <EntityFactGraphCanvas
            data={graphData}
            selectedId={selectedId}
            onSelect={(nodeId) => selectNode(nodeId ?? graphData.rootId)}
          />
        </div>
      </div>
    );
  }

  const selectedNode = graphData.nodes.find((node) => node.id === selectedId) ?? graphData.nodes[0];
  const selectedMemory = selectedNode.kind === 'fact' ? selectedNode.memory ?? null : null;
  const selectedAppliedFact = selectedNode.kind === 'fact' ? selectedNode.fact ?? null : null;
  const selectedMeta =
    selectedNode.kind === 'fact'
      ? selectedAppliedFact
        ? t('contextRoom:memory.factSourceCount', { count: selectedAppliedFact.sourceCount })
        : t('contextRoom:memory.statusRoomOnlyRoom', { status: t(uiText(selectedNode.memory!.status)), room: room.title })
      : selectedNode.mentionCount !== undefined
        ? t('contextRoom:memory.appliedEntityMeta', {
          type: t(uiText(selectedNode.entityType)),
          count: selectedNode.mentionCount,
        })
        : t('contextRoom:memory.typeEntity', { type: t(uiText(selectedNode.entityType)) });
  const isRootEntity = selectedNode.id === graphData.rootId;
  const isPerson = selectedNode.kind === 'entity' && selectedNode.entityType === '人物';
  const DetailIcon = selectedMemory
    ? MessageSquareText
    : isRootEntity
      ? Target
      : isPerson
        ? UserRound
        : CircleDot;
  // 关联事实：应用实体按 entityId 直查（图上每条事实只连 ≤3 个实体，直查更完整）；
  // 静态实体/根节点沿用边推导。
  const edgeLinkedFacts = graphData.edges
    .filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
    .map((edge) =>
      graphData.nodes.find(
        (node) =>
          node.id === (edge.source === selectedNode.id ? edge.target : edge.source) &&
          node.kind === 'fact'
      )
    )
    .filter((node): node is EntityFactGraphFactNode => Boolean(node));
  const linkedFacts = selectedNode.kind === 'entity' && selectedNode.entityId
    ? (appliedMemory?.facts ?? [])
        .filter((fact) => fact.entityIds.includes(selectedNode.entityId!))
        .map((fact) => graphData.nodes.find(
          (node) => node.kind === 'fact' && node.id === `applied-fact:${fact.factId}`,
        ))
        .filter((node): node is EntityFactGraphFactNode => Boolean(node))
    : edgeLinkedFacts;

  return (
    <div className="context-room-memory-pane">
      <header>
        <h2>{t('contextRoom:memory.entitiesAndFacts')}</h2>
        {hasGraphContent ? (
          <button type="button" onClick={() => setShowFullGraph(true)}>
            <Maximize2 aria-hidden="true" />
            {t('contextRoom:memory.fullGraph')}
          </button>
        ) : null}
      </header>
      {hasGraphContent ? (
        <div className="context-room-memory-overview">
          <div className="context-room-memory-graph-stage">
            <EntityFactGraphCanvas
              data={graphData}
              selectedId={selectedNode.id}
              onSelect={(nodeId) => selectNode(nodeId ?? graphData.rootId)}
            />
          </div>
          <article
            className="context-room-memory-inline-detail"
            data-memory-kind={selectedNode.kind}
          >
            <header>
              <span className="context-room-memory-detail-icon">
                <DetailIcon aria-hidden="true" />
              </span>
              <span>
                <h3>
                  {selectedMemory
                    ? t(uiText(selectedMemory.type))
                    : selectedAppliedFact
                      ? t(`contextRoom:memory.factType.${selectedAppliedFact.type === '关系' ? 'relation' : 'attribute'}`)
                      : selectedNode.label}
                  {selectedNode.kind === 'entity' && selectedNode.status ? (
                    <span
                      className="context-room-memory-entity-status"
                      data-status={selectedNode.status}
                    >
                      {t(`contextRoom:memory.entityStatus.${selectedNode.status}`)}
                    </span>
                  ) : null}
                </h3>
                <small>{selectedMeta}</small>
              </span>
            </header>
            <p>{localizedUiText(selectedNode.description, t)}</p>
            {selectedNode.kind === 'entity' && selectedNode.lastMentionAt ? (
              <small className="context-room-memory-entity-mention">
                {t('contextRoom:memory.lastMentionAt', {
                  time: formatRoomUpdatedTime(selectedNode.lastMentionAt, selectedNode.lastMentionAt, locale, t),
                })}
              </small>
            ) : null}
            <section>
              <div className="context-room-memory-detail-section-head">
                <span>{t(selectedNode.kind === 'fact' ? 'contextRoom:memory.sources' : 'contextRoom:memory.relatedFacts')}</span>
                <small>
                  {selectedNode.kind === 'fact'
                    ? (selectedAppliedFact?.sources.length ?? selectedMemory?.sources?.length ?? 0)
                    : linkedFacts.length}
                </small>
              </div>
              <div className="context-room-memory-detail-list">
                {selectedMemory
                  ? selectedMemory.sources?.map((source) => (
                      <button
                        type="button"
                        key={`${source.type}-${source.name}`}
                        onClick={() => onOpenMemory(selectedMemory.id)}
                      >
                        <span className="context-room-memory-detail-row-icon">
                          <Link2 aria-hidden="true" />
                        </span>
                        <span>
                          <b>{source.name}</b>
                          <small>{t(uiText(source.type))}</small>
                        </span>
                      </button>
                    ))
                  : selectedAppliedFact
                    ? selectedAppliedFact.sources.map((source) => {
                        const kindLabel = t(`contextRoom:memory.sourceKind.${source.sourceKind}`);
                        return (
                          <div
                            className="context-room-memory-source-row"
                            key={`${source.sourceKind}-${source.sourceId}`}
                          >
                            <span className="context-room-memory-detail-row-icon">
                              <Link2 aria-hidden="true" />
                            </span>
                            <span>
                              <b>{source.sourceTitle ?? kindLabel}</b>
                              <small>
                                {kindLabel}
                                {' · '}
                                {formatRoomUpdatedTime(source.mentionedAt, source.mentionedAt, locale, t)}
                              </small>
                            </span>
                          </div>
                        );
                      })
                    : linkedFacts.map((fact) => (
                      <button type="button" key={fact.id} onClick={() => selectNode(fact.id)}>
                        <span className="context-room-memory-detail-row-icon">
                          <MessageSquareText aria-hidden="true" />
                        </span>
                        <span>
                          <b>{localizedUiText(fact.description, t)}</b>
                          <small>{t(uiText(fact.label))}</small>
                        </span>
                      </button>
                    ))}
                {selectedMemory && !selectedMemory.sources?.length ? (
                  <span className="context-room-memory-detail-empty">{t('contextRoom:memory.noSources')}</span>
                ) : null}
                {selectedNode.kind === 'entity' && !linkedFacts.length ? (
                  <span className="context-room-memory-detail-empty">{t('contextRoom:memory.noRelatedFacts')}</span>
                ) : null}
              </div>
            </section>
            {selectedNode.kind === 'entity' && selectedNode.sources?.length ? (
              <section>
                <div className="context-room-memory-detail-section-head">
                  <span>{t('contextRoom:memory.sourceMaterials')}</span>
                  <small>{selectedNode.sources.length}</small>
                </div>
                <div className="context-room-memory-detail-list">
                  {selectedNode.sources.map((source) => {
                    const kindLabel = t(`contextRoom:memory.sourceKind.${source.sourceKind}`);
                    return (
                      <div
                        className="context-room-memory-source-row"
                        key={`${source.sourceKind}-${source.sourceId}`}
                      >
                        <span className="context-room-memory-detail-row-icon">
                          <Link2 aria-hidden="true" />
                        </span>
                        <span>
                          <b>{source.evidence ?? source.sourceTitle ?? kindLabel}</b>
                          <small>
                            {source.sourceTitle ? `${source.sourceTitle} · ${kindLabel}` : kindLabel}
                            {' · '}
                            {formatRoomUpdatedTime(source.mentionedAt, source.mentionedAt, locale, t)}
                          </small>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}
            {selectedMemory ? (
              <footer>
                <button
                  type="button"
                  className="context-room-ghost"
                  disabled={selectedMemory.status === '已禁用'}
                  onClick={() => setDisableConfirmOpen(true)}
                >
                  {t(selectedMemory.status === '已禁用' ? 'contextRoom:memory.disabled' : 'contextRoom:memory.disable')}
                </button>
              </footer>
            ) : null}
          </article>
        </div>
      ) : (
        <PanelEmptyState
          icon={Network}
          title={t('contextRoom:memory.noEntitiesOrFactsYet')}
          description={t('contextRoom:memory.peopleRelationshipsAndMemoryFactsExtractedInThe')}
        />
      )}
      {selectedMemory ? (
        <ActionConfirmDialog
          open={disableConfirmOpen}
          onOpenChange={setDisableConfirmOpen}
          title={t('contextRoom:memory.disableMemory')}
          summary={t('contextRoom:memory.agentWillNoLongerUseThisMemoryIn')}
          rows={[
            { label: t('contextRoom:memory.memoryType'), value: t(uiText(selectedMemory.type)) },
            { label: t('contextRoom:memory.scope'), value: room.title },
          ]}
          sources={selectedMemory.sources ?? []}
          risk={t('contextRoom:memory.disablingDoesNotDeleteTheSourceYouCan')}
          confirmLabel={t('contextRoom:memory.confirmDisable')}
          danger
          onConfirm={() =>
            onUpdateRoom((current) => ({
              ...current,
              memoryItems: current.memoryItems.map((item) =>
                item.id === selectedMemory.id ? { ...item, status: '已禁用' } : item
              ),
            }))
          }
        />
      ) : null}
    </div>
  );
}
