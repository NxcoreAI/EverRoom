import type { RoomDocument } from '@nxcore/agent-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Brain, Network, Target, ExternalLink, LocateFixed } from 'lucide-react'

import { useLocale } from '../../../../../i18n/LocaleContext';
import type { ContextRoomRecord } from '../../types'
import { requestDocumentBlockNavigation } from '../detail-editor/documentBlockNavigation'
import { LinkGraphCanvas } from '../LinkGraphCanvas'
import { edgeSourceNodeId, edgeTargetNodeId } from '../LinkGraphCanvas'
import {
  LINK_GRAPH_ROOT_ID,
  buildLinkGraphData,
  filterLinkGraphData,
  type LinkGraphEdge,
  type LinkGraphFilter,
  type LinkGraphNode,
} from '../linkGraphModel'
import { PanelEmptyState } from './PanelEmptyState'

/**
 * Room 建联图谱面板（块级星系模型）：文档节点外圈是带建联文本块的圆形轨道场，
 * 边为 块→目标块 / 块→记忆。数据是 Room 文档 content 的纯读侧投影，与文档天然同步。
 */
export function LinkGraphPane({
  room,
  backendDocuments,
  trashedDocuments,
  onOpenDocument,
  focusNodeId,
}: {
  room: ContextRoomRecord;
  backendDocuments: RoomDocument[];
  trashedDocuments: RoomDocument[];
  /** 右区打开文档（编辑栏常驻）。 */
  onOpenDocument: (documentId: string) => void;
  /** 索引 chip 跳转等外部聚焦请求：选中对应节点（不存在则忽略）。 */
  focusNodeId?: string | null;
}) {
  const { t } = useLocale();
  // 刷新机制与其他图谱同款（见 useRoomAppliedEntities）：挂载取一次快照，
  // 之后只在 everroom:knowledge-changed 事件或 room.updatedAt 变化时刷新——
  // 不跟随每次文档保存（backendDocuments 每次保存都是新数组，直接做依赖
  // 会导致画布在编辑期间反复重建）。
  const documentsRef = useRef(backendDocuments);
  documentsRef.current = backendDocuments;
  const trashedRef = useRef(trashedDocuments);
  trashedRef.current = trashedDocuments;
  const [snapshot, setSnapshot] = useState(() => ({
    documents: backendDocuments,
    trashedDocuments,
  }));
  const refreshSnapshot = useCallback(() => {
    setSnapshot((current) => {
      if (current.documents === documentsRef.current && current.trashedDocuments === trashedRef.current) {
        return current
      }
      return { documents: documentsRef.current, trashedDocuments: trashedRef.current }
    })
  }, []);

  useEffect(() => {
    window.addEventListener('everroom:knowledge-changed', refreshSnapshot);
    return () => window.removeEventListener('everroom:knowledge-changed', refreshSnapshot);
  }, [refreshSnapshot]);

  const lastUpdatedAtRef = useRef(room.updatedAt);
  useEffect(() => {
    if (room.updatedAt === lastUpdatedAtRef.current) return;
    lastUpdatedAtRef.current = room.updatedAt;
    refreshSnapshot();
  }, [room.updatedAt, refreshSnapshot]);

  const fullData = useMemo(
    () => buildLinkGraphData(room, snapshot.documents, snapshot.trashedDocuments),
    [room, snapshot],
  );
  const [filter, setFilter] = useState<LinkGraphFilter>('all');
  const data = useMemo(() => filterLinkGraphData(fullData, filter), [fullData, filter]);
  const [selectedId, setSelectedId] = useState<string | null>(data.rootId);

  useEffect(() => {
    setSelectedId(data.rootId);
  }, [data.rootId, room.id]);

  // 外部聚焦（chip 跳转）：焦点变化且节点在图上时选中；同值重复请求不重选。
  useEffect(() => {
    if (!focusNodeId) return;
    if (data.nodes.some((node) => node.id === focusNodeId)) setSelectedId(focusNodeId);
  }, [focusNodeId, data.nodes]);

  const nodeById = useMemo(
    () => new Map(data.nodes.map((node) => [node.id, node])),
    [data.nodes],
  );
  const docById = useMemo(
    () => new Map(backendDocuments.map((document) => [document.id, document])),
    [backendDocuments],
  );
  const selected: LinkGraphNode = data.nodes.find((node) => node.id === selectedId)
    ?? data.nodes[0]!;

  const rowButton = (key: string, icon: 'doc' | 'memory' | 'block', label: string, meta: string, onClick: () => void) => (
    <button type="button" key={key} onClick={onClick}>
      <span className="context-room-memory-detail-row-icon">
        {icon === 'memory' ? <Brain aria-hidden="true" /> : icon === 'block' ? <LocateFixed aria-hidden="true" /> : <FileText aria-hidden="true" />}
      </span>
      <span>
        <b>{label}</b>
        <small>{meta}</small>
      </span>
    </button>
  )

  const selectNodeById = (nodeId: string | null | undefined) => {
    if (nodeId && nodeById.has(nodeId)) setSelectedId(nodeId)
  }

  // 选中节点关联数据。
  const selectedBlocks = selected.kind === 'document' && selected.documentId
    ? data.nodes.filter((node) => node.kind === 'block' && node.parentDocumentId === selected.documentId)
    : []
  const outgoingEdges = selected.kind === 'block' && selected.parentDocumentId && selected.blockId
    ? data.edges.filter((edge) =>
      edge.sourceDocumentId === selected.parentDocumentId && edge.sourceBlockId === selected.blockId)
    : selected.kind === 'document' && selected.documentId && !selected.stale
      ? data.edges.filter((edge) => edge.sourceDocumentId === selected.documentId)
      : []
  const incomingEdges = selected.kind === 'memory' && selected.memoryId
    ? data.edges.filter((edge) => edge.kind === 'memory' && edge.targetMemoryId === selected.memoryId)
    : selected.kind === 'block' && selected.parentDocumentId && selected.blockId
      ? data.edges.filter((edge) =>
        edge.kind === 'document' && edge.targetDocumentId === selected.parentDocumentId
        && edge.targetBlockId === selected.blockId)
      : selected.kind === 'document' && selected.documentId
        ? data.edges.filter((edge) => edge.kind === 'document' && edge.targetDocumentId === selected.documentId)
        : []

  const edgePeerLabel = (edge: LinkGraphEdge, direction: 'outgoing' | 'incoming'): string => {
    if (direction === 'outgoing') {
      const targetNode = nodeById.get(edgeTargetNodeId(edge))
      return targetNode?.label || edge.label || (edge.kind === 'memory' ? '记忆' : '文档')
    }
    const sourceNode = nodeById.get(edgeSourceNodeId(edge))
    if (sourceNode?.kind === 'block') {
      const docTitle = docById.get(edge.sourceDocumentId)?.title ?? edge.sourceDocumentId
      return `${docTitle} · ${sourceNode.label}`
    }
    return sourceNode?.label || docById.get(edge.sourceDocumentId)?.title || edge.sourceDocumentId
  }

  if (fullData.edges.length === 0 && fullData.totals.dangling === 0) {
    return (
      <PanelEmptyState
        icon={Network}
        title={t('contextRoom:linkGraph.emptyTitle')}
        description={t('contextRoom:linkGraph.emptyDescription')}
      />
    );
  }

  const filterOptions: Array<{ value: LinkGraphFilter; label: string }> = [
    { value: 'all', label: t('contextRoom:linkGraph.filterAll') },
    { value: 'documents', label: t('contextRoom:linkGraph.filterDocuments') },
    { value: 'memories', label: t('contextRoom:linkGraph.filterMemories') },
  ]

  const metaKey = selected.kind === 'root'
    ? 'contextRoom:linkGraph.rootMeta'
    : selected.kind === 'memory'
      ? 'contextRoom:linkGraph.memoryNodeMeta'
      : selected.kind === 'block'
        ? 'contextRoom:linkGraph.blockNodeMeta'
        : 'contextRoom:linkGraph.documentNodeMeta'

  return (
    <div className="context-room-memory-pane">
      <header>
        <h2>{t('contextRoom:linkGraph.title')}</h2>
        <select
          className="context-room-link-graph-filter"
          aria-label={t('contextRoom:linkGraph.filterLabel')}
          value={filter}
          onChange={(event) => setFilter(event.target.value as LinkGraphFilter)}
        >
          {filterOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <small>
          {t('contextRoom:linkGraph.totals', {
            documents: data.totals.documents,
            memories: data.totals.memories,
            links: data.totals.links,
          })}
          {data.totals.dangling > 0 ? (
            <span className="context-room-memory-entity-status" data-status="suppressed">
              {t('contextRoom:linkGraph.dangling', { count: data.totals.dangling })}
            </span>
          ) : null}
        </small>
      </header>
      <div className="context-room-memory-overview">
        <div className="context-room-memory-graph-stage">
          <LinkGraphCanvas
            data={data}
            selectedId={selected.id}
            onSelect={(nodeId) => setSelectedId(nodeId ?? data.rootId)}
          />
        </div>
        <article
          className="context-room-memory-inline-detail"
          data-memory-kind={selected.kind === 'memory' ? 'fact' : 'entity'}
        >
          <header>
            <span className="context-room-memory-detail-icon">
              {selected.kind === 'memory' ? <Brain aria-hidden="true" /> : selected.kind === 'root' ? <Target aria-hidden="true" /> : selected.kind === 'block' ? <LocateFixed aria-hidden="true" /> : <FileText aria-hidden="true" />}
            </span>
            <span>
              <h3>
                {selected.label}
                {selected.stale ? (
                  <span className="context-room-memory-entity-status" data-status="suppressed">
                    {t('contextRoom:linkGraph.staleTarget')}
                  </span>
                ) : null}
              </h3>
              <small>{t(metaKey)}</small>
            </span>
          </header>
          <p>{selected.description}</p>
          <div className="context-room-memory-detail-list">
            {selected.kind === 'block' && selected.parentDocumentId && selected.blockId ? rowButton(
              'locate', 'block',
              t('contextRoom:linkGraph.locateParagraph'),
              t('contextRoom:linkGraph.jumpToParagraph'),
              () => requestDocumentBlockNavigation({
                roomId: room.id,
                documentId: selected.parentDocumentId!,
                blockId: selected.blockId!,
              }),
            ) : null}
            {selected.kind === 'document' && selected.documentId && !selected.stale ? rowButton(
              'open-doc', 'doc',
              t('contextRoom:linkGraph.openDocument'),
              t('contextRoom:linkGraph.openHint'),
              () => onOpenDocument(selected.documentId!),
            ) : null}
          </div>
          {selected.kind === 'document' && selected.documentId ? (
            <section>
              <div className="context-room-memory-detail-section-head">
                <span>{t('contextRoom:linkGraph.linkedBlocks')}</span>
                <small>{selectedBlocks.length}</small>
              </div>
              <div className="context-room-memory-detail-list">
                {selectedBlocks.length
                  ? selectedBlocks.map((block) => rowButton(
                    block.id, 'block', block.label,
                    t('contextRoom:linkGraph.jumpToParagraph'),
                    () => setSelectedId(block.id),
                  ))
                  : <small>{t('contextRoom:linkGraph.noLinkedBlocks')}</small>}
              </div>
            </section>
          ) : null}
          {selected.kind !== 'root' ? (
            <>
              <section>
                <div className="context-room-memory-detail-section-head">
                  <span>{t('contextRoom:linkGraph.asSource')}</span>
                  <small>{outgoingEdges.length}</small>
                </div>
                <div className="context-room-memory-detail-list">
                  {outgoingEdges.length
                    ? outgoingEdges.map((edge) => rowButton(
                      edge.id, edge.kind === 'memory' ? 'memory' : 'doc',
                      edgePeerLabel(edge, 'outgoing'),
                      t('contextRoom:linkGraph.edgeCount', { count: edge.count }),
                      () => selectNodeById(edgeTargetNodeId(edge)),
                    ))
                    : <small>{t('contextRoom:linkGraph.noEdges')}</small>}
                </div>
              </section>
              <section>
                <div className="context-room-memory-detail-section-head">
                  <span>{t('contextRoom:linkGraph.asTarget')}</span>
                  <small>{incomingEdges.length}</small>
                </div>
                <div className="context-room-memory-detail-list">
                  {incomingEdges.length
                    ? incomingEdges.map((edge) => rowButton(
                      edge.id, 'block',
                      edgePeerLabel(edge, 'incoming'),
                      t('contextRoom:linkGraph.edgeCount', { count: edge.count }),
                      () => selectNodeById(edgeSourceNodeId(edge)),
                    ))
                    : <small>{t('contextRoom:linkGraph.noEdges')}</small>}
                </div>
              </section>
            </>
          ) : null}
        </article>
      </div>
    </div>
  );
}
