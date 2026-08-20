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
          <h2>{t('Room 记忆')}</h2>
          <button type="button" onClick={() => setShowFullGraph(false)}>
            <ChevronLeft aria-hidden="true" />
            {t('返回实体与事实')}
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
      ? t('{status} · 仅 Room：{room}', { status: t(selectedNode.memory.status), room: room.title })
      : t('{type} · 实体', { type: t(selectedNode.entityType) });
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
        <h2>{t('实体与事实')}</h2>
        {hasGraphContent ? (
          <button type="button" onClick={() => setShowFullGraph(true)}>
            <Maximize2 aria-hidden="true" />
            {t('完整图谱')}
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
                <h3>{selectedMemory ? t(selectedMemory.type) : selectedNode.label}</h3>
                <small>{selectedMeta}</small>
              </span>
            </header>
            <p>{selectedNode.description}</p>
            <section>
              <div className="context-room-memory-detail-section-head">
                <span>{t(selectedMemory ? '来源' : '关联记忆')}</span>
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
                          <small>{t(source.type)}</small>
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
                  <span className="context-room-memory-detail-empty">{t('暂无来源')}</span>
                ) : null}
                {!selectedMemory && !linkedFacts.length ? (
                  <span className="context-room-memory-detail-empty">{t('暂无关联记忆')}</span>
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
                  {t(selectedMemory.status === '已禁用' ? '已禁用' : '禁用')}
                </button>
              </footer>
            ) : null}
          </article>
        </div>
      ) : (
        <PanelEmptyState
          icon={Network}
          title={t('还没有实体与事实')}
          description={t('Room 中提取的人物、关系和记忆事实会形成图谱。')}
        />
      )}
      {selectedMemory ? (
        <ActionConfirmDialog
          open={disableConfirmOpen}
          onOpenChange={setDisableConfirmOpen}
          title={t('禁用记忆')}
          summary={t('Agent 将不再使用这条记忆参与回答和执行。')}
          rows={[
            { label: t('记忆类型'), value: t(selectedMemory.type) },
            { label: t('作用范围'), value: room.title },
          ]}
          sources={selectedMemory.sources ?? []}
          risk={t('禁用不会删除原始资料，可稍后重新启用或继续编辑。')}
          confirmLabel={t('确认禁用')}
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
