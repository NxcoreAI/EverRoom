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

import type { ContextRoomRecord } from '../../types';
import { uiText } from '../../adapters';
import { EntityFactGraphCanvas } from '../EntityFactGraphCanvas';
import { createEntityFactGraphData } from '../entityFactGraphModel';
import { ActionConfirmDialog } from '../shared';
import { PanelEmptyState } from './PanelEmptyState';

export function MemoryPane({
  room,
  onOpenMemory,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  onOpenMemory: (id: string) => void;
  onUpdateRoom: (updater: (room: ContextRoomRecord) => ContextRoomRecord) => void;
}) {
  const { t } = useLocale();
  const graphData = useMemo(() => createEntityFactGraphData(room), [room]);
  const [showFullGraph, setShowFullGraph] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => graphData.rootId);
  const [disableConfirmOpen, setDisableConfirmOpen] = useState(false);
  const hasGraphContent = Boolean(
    room.memoryItems.length || room.people.length || room.graphEdges.length
  );

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
            onSelect={(nodeId) => setSelectedId(nodeId ?? graphData.rootId)}
          />
        </div>
      </div>
    );
  }

  const selectedNode = graphData.nodes.find((node) => node.id === selectedId) ?? graphData.nodes[0];
  const selectedMemory = selectedNode.kind === 'fact' ? selectedNode.memory : null;
  const selectedMeta =
    selectedNode.kind === 'fact'
      ? t('contextRoom:memory.statusRoomOnlyRoom', { status: t(uiText(selectedNode.memory.status)), room: room.title })
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
  const linkedFacts = graphData.edges
    .filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
    .map((edge) =>
      graphData.nodes.find(
        (node) =>
          node.id === (edge.source === selectedNode.id ? edge.target : edge.source) &&
          node.kind === 'fact'
      )
    )
    .filter((node): node is Extract<(typeof graphData.nodes)[number], { kind: 'fact' }> =>
      Boolean(node)
    );

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
              onSelect={(nodeId) => setSelectedId(nodeId ?? graphData.rootId)}
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
                <h3>{selectedMemory ? t(uiText(selectedMemory.type)) : selectedNode.label}</h3>
                <small>{selectedMeta}</small>
              </span>
            </header>
            <p>{selectedNode.description}</p>
            <section>
              <div className="context-room-memory-detail-section-head">
                <span>{t(selectedMemory ? 'contextRoom:memory.sources' : 'contextRoom:memory.relatedMemories')}</span>
                <small>
                  {selectedMemory ? (selectedMemory.sources?.length ?? 0) : linkedFacts.length}
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
                  : linkedFacts.map((fact) => (
                      <button type="button" key={fact.id} onClick={() => setSelectedId(fact.id)}>
                        <span className="context-room-memory-detail-row-icon">
                          <MessageSquareText aria-hidden="true" />
                        </span>
                        <span>
                          <b>{fact.description}</b>
                          <small>{fact.label}</small>
                        </span>
                      </button>
                    ))}
                {selectedMemory && !selectedMemory.sources?.length ? (
                  <span className="context-room-memory-detail-empty">{t('contextRoom:memory.noSources')}</span>
                ) : null}
                {!selectedMemory && !linkedFacts.length ? (
                  <span className="context-room-memory-detail-empty">{t('contextRoom:memory.noRelatedMemories')}</span>
                ) : null}
              </div>
            </section>
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
