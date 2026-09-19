import { ChevronDown, ChevronUp, ListTree, Quote } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TreeGraph } from '@antv/g6';

import { useLocale } from '../../../../../i18n/LocaleContext';
import type { EmergenceCardDto, EmergenceProjectionResultDto } from '../../../../../../../shared/knowledge';
import { GraphCanvasTools } from './GraphCanvasTools';
import { buildFocusSubtree, type FocusSubtree } from './focusTreeModel';
import {
  createFocusGraph, focusTreeData, placeParentLeft, setCameraOnNode, recenterCamera,
  registerLiveGraph, unregisterLiveGraph, updateFocusGraph, visCenterY,
} from './g6FocusGraph';

/**
 * 聚焦态思维导图：G6 TreeGraph 引擎（原型 lib/contextroom.js 原样移植）。
 * 点非中心节点=钻取换根（压栈），回程框=历史栈回退；底部详情条随选中联动。
 */
export function FocusTreeCanvas({
  result,
  centerRef,
  returnRef,
  selectedNodeRef,
  cards,
  onDrill,
  onGoBack,
  onSelectNode,
  onOpenCard,
  onCardAction,
}: {
  result: EmergenceProjectionResultDto;
  /** 已过 resolveCenter 兜底的当前中心。 */
  centerRef: string;
  /** 钻取前的中心（历史栈上一层），渲染为根左侧回程框。 */
  returnRef: string | null;
  selectedNodeRef: string | null;
  cards: EmergenceCardDto[];
  onDrill: (nodeRef: string) => void;
  onGoBack: () => void;
  onSelectNode: (nodeRef: string | null) => void;
  onOpenCard?: (nodeRef: string) => void;
  onCardAction: (card: EmergenceCardDto) => void;
}) {
  const { t } = useLocale();
  const viewportRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<TreeGraph | null>(null);
  const lastAppliedRef = useRef<FocusSubtree | null>(null);
  const prevCenterRef = useRef(centerRef);
  const [stripCollapsed, setStripCollapsed] = useState(false);

  const subtree = useMemo(() => buildFocusSubtree(result, centerRef, returnRef), [result, centerRef, returnRef]);
  const nodeById = useMemo(() => new Map(subtree.nodes.map((node) => [node.id, node])), [subtree]);
  const cardByNode = useMemo(() => {
    const map = new Map<string, EmergenceCardDto>();
    for (const card of cards) {
      if (card.nodeRef && !map.has(card.nodeRef)) map.set(card.nodeRef, card);
    }
    return map;
  }, [cards]);

  const stripSubject = selectedNodeRef && nodeById.has(selectedNodeRef)
    ? selectedNodeRef
    : (nodeById.has(centerRef) ? centerRef : null);
  const stripNode = stripSubject !== null ? nodeById.get(stripSubject) ?? null : null;
  const stripCard = stripSubject !== null ? cardByNode.get(stripSubject) ?? null : null;

  // 点击语义走最新闭包（图实例只建一次）
  const clickRef = useRef<(id: string) => void>(() => {});
  clickRef.current = useCallback((id: string) => {
    const node = nodeById.get(id);
    if (!node) return;
    if (node.isReturn) {
      onGoBack();
      return;
    }
    if (node.id === centerRef) {
      onSelectNode(selectedNodeRef === node.id ? null : node.id);
      return;
    }
    if (node.depth === 1 || node.expandable) onDrill(node.id);
    else onSelectNode(node.id);
  }, [nodeById, centerRef, selectedNodeRef, onGoBack, onDrill, onSelectNode]);

  const hasTree = subtree.nodes.length > 0;

  // 建图一次（空树时挂载点不存在，出树后再建）；尺寸变化 → 防抖 changeSize + 重布局 + 相机归位（原型 watchMountSize）
  useEffect(() => {
    const el = mountRef.current;
    if (!el || graphRef.current) return;
    const graph = createFocusGraph(el, focusTreeData(subtree), (id) => clickRef.current(id));
    graphRef.current = graph;
    lastAppliedRef.current = subtree;
    registerLiveGraph(graph);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const apply = () => {
      if (!el.isConnected || !el.clientWidth || !el.clientHeight) return;
      try {
        graph.changeSize(el.clientWidth, el.clientHeight);
        graph.refreshLayout();
        placeParentLeft(graph);
        setCameraOnNode(graph, subtree.center, graph.getZoom() || 1, { x: el.clientWidth / 2, y: visCenterY(graph) });
      } catch { /* 已销毁 */ }
    };
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(apply, 160);   // 防抖：拖动分隔条/窗口调整不逐帧重排
      });
      observer.observe(el);
    }
    return () => {
      if (timer) clearTimeout(timer);
      observer?.disconnect();
      unregisterLiveGraph(graph);
      try { graph.destroy(); } catch { /* 已销毁 */ }
      graphRef.current = null;
      lastAppliedRef.current = null;
    };
    // 建图吃掉当帧数据；后续数据变化由下方换树 effect 接管
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTree]);

  // 数据/中心变化：钻取/层级切换=动画换树+推近相机；同中心刷新=换树不推近（原型语义）
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || lastAppliedRef.current === subtree) return;
    lastAppliedRef.current = subtree;
    const datum = focusTreeData(subtree);
    const centerChanged = prevCenterRef.current !== subtree.center;
    prevCenterRef.current = subtree.center;
    if (centerChanged) updateFocusGraph(graph, datum, subtree.center);
    else {
      // 同中心刷新：钉屏换树 + 回程框归位 + 变形居中，不推近
      graph.changeData(datum);
      placeParentLeft(graph);
      setTimeout(() => { try { recenterCamera(graph, subtree.center); } catch { /* 已销毁 */ } }, 60);
    }
  }, [subtree]);

  const canvasTools = useMemo(() => ({
    zoomBy: (factor: number) => {
      const graph = graphRef.current;
      if (!graph) return;
      const z = graph.getZoom();
      const next = Math.max(0.2, Math.min(3, (Number.isFinite(z) && z > 0 ? z : 1) * factor));
      setCameraOnNode(graph, subtree.center, next, { x: (graph.get('width') || 0) / 2, y: visCenterY(graph) });
    },
    fitAll: () => {
      const graph = graphRef.current;
      if (!graph) return;
      try { graph.fitView(24); } catch { /* 已销毁 */ }
    },
    recenter: () => {
      const graph = graphRef.current;
      if (!graph) return;
      setCameraOnNode(graph, subtree.center, graph.getZoom() || 1, { x: (graph.get('width') || 0) / 2, y: visCenterY(graph) });
    },
  }), [subtree]);

  if (!hasTree) {
    return <div className="eg-viewport eg-empty">{t('contextRoom:emergence.veinEmpty')}</div>;
  }

  return (
    <div ref={viewportRef} className="eg-viewport" aria-label={t('contextRoom:emergence.veinCanvas')}>
      <div ref={mountRef} className="eg-g6-mount" />
      {stripNode ? (
        <div
          className={`eg-strip${stripCollapsed ? ' is-collapsed' : ''}`}
          data-eg-strip=""
        >
          <div className="eg-strip-bar">
            <strong title={stripCard?.title ?? stripNode.node.label}>{stripCard?.title ?? stripNode.node.label}</strong>
            <button
              type="button"
              className="eg-strip-fold"
              title={t(stripCollapsed ? 'contextRoom:emergence.detailExpand' : 'contextRoom:emergence.detailCollapse')}
              aria-label={t(stripCollapsed ? 'contextRoom:emergence.detailExpand' : 'contextRoom:emergence.detailCollapse')}
              onClick={() => setStripCollapsed((value) => !value)}
            >
              {stripCollapsed ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            </button>
          </div>
          {stripCollapsed ? null : (
            <>
              {stripCard?.quote ? <blockquote>{stripCard.quote}</blockquote> : null}
              {stripCard ? <p>{stripCard.summary}</p> : null}
              {stripCard && stripSubject !== null ? (
                <div className="eg-strip-actions">
                  {onOpenCard ? (
                    <button type="button" onClick={() => onOpenCard(stripSubject)}>
                      <ListTree aria-hidden="true" />
                      {t('contextRoom:emergence.viewInCards')}
                    </button>
                  ) : null}
                  <button type="button" className="is-primary" onClick={() => onCardAction(stripCard)}>
                    <Quote aria-hidden="true" />
                    {t('contextRoom:emergence.quote')}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <GraphCanvasTools actions={canvasTools} />
    </div>
  );
}
