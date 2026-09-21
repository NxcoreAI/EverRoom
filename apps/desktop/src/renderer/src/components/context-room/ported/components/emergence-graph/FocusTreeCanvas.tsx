import { ChevronDown, ChevronUp, ListTree, Quote } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TreeGraph } from '@antv/g6';

import { useLocale } from '../../../../../i18n/LocaleContext';
import type { EmergenceCardDto, EmergenceProjectionResultDto } from '../../../../../../../shared/knowledge';
import { GraphCanvasTools } from './GraphCanvasTools';
import { buildFocusTree, defaultCollapsed, revealAncestors, type FocusTree } from './focusTreeModel';
import {
  animateFitView, animateRecenter, createFocusGraph, focusTreeData, setCameraOnNode,
  registerLiveGraph, tweenCameraTo, tweenCameraToNode, unregisterLiveGraph,
  updateFocusGraph, visCenterY,
} from './g6FocusGraph';

/**
 * 聚焦态思维导图（NotebookLM 式）：默认只见根和一级分支，一级全收起；
 * 收起的中级节点点=原地展开并选中，已展开没选中的点回=只选中不收起，
 * 已选中且展开的再点=收起并取消选中，点叶子/根=只选中看底部详情条。
 * 选中节点保证邻居可见：根保持展开（点根只选中不收图）、叶子把父链展开；
 * 中间节点自身的收起态不随选中变化。新导图（结果身份变化）重置回收起默认态。
 */
export function FocusTreeCanvas({
  result,
  rootRef,
  selectedNodeRef,
  cards,
  showDetail = true,
  onSelectNode,
  onOpenCard,
  onCardAction,
}: {
  result: EmergenceProjectionResultDto;
  /** 已过 resolveCenter 兜底的树根。 */
  rootRef: string;
  selectedNodeRef: string | null;
  cards: EmergenceCardDto[];
  /** 大弹窗等纯浏览场景不带底部详情条（含小字摘要与操作）。 */
  showDetail?: boolean;
  onSelectNode: (nodeRef: string | null) => void;
  onOpenCard?: (nodeRef: string) => void;
  onCardAction?: (card: EmergenceCardDto) => void;
}) {
  const { t } = useLocale();
  const viewportRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<TreeGraph | null>(null);
  const lastDatumRef = useRef<ReturnType<typeof focusTreeData> | null>(null);
  const [stripCollapsed, setStripCollapsed] = useState(false);

  const tree = useMemo(() => buildFocusTree(result, rootRef), [result, rootRef]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => defaultCollapsed(tree));

  // 新导图=回到默认收起态：渲染期重置（无空帧）；上一份必须存 state
  // （存 ref 会在严格模式双渲染下丢重置）。
  const [prevTree, setPrevTree] = useState<FocusTree>(tree);
  if (tree !== prevTree) {
    setPrevTree(tree);
    setCollapsed(defaultCollapsed(tree));
  }

  // 相机中心目标：换树 datum effect 消费后清空
  const cameraTargetRef = useRef<string | null>(null);
  // 焦点按钮补展开标记：换树落定后按「父级+子树」局部取景，而非保持原缩放
  const focusFitRef = useRef(false);

  // 选中即带邻居可见（含挂载时已带选中，如卡片视图展开深层卡片后切回脉络图）：
  // 叶子上溯展开父链、根保持展开；被选节点自身的收起态不动。上一份同样必须存 state。
  const [prevSelected, setPrevSelected] = useState<string | null>(null);
  if (selectedNodeRef !== prevSelected) {
    setPrevSelected(selectedNodeRef);
    const revealed = selectedNodeRef !== null ? revealAncestors(tree, collapsed, selectedNodeRef) : null;
    if (revealed) {
      setCollapsed(revealed);
      cameraTargetRef.current = selectedNodeRef;
    } else if (selectedNodeRef !== null && tree.byId.has(selectedNodeRef)) {
      // 无需揭示（本来就可见，如路径链点同级/父级）：相机轻推过去即可
      const graph = graphRef.current;
      if (graph && graph.findById(selectedNodeRef)) tweenCameraToNode(graph, selectedNodeRef, graph.getZoom() || 1, 380);
    }
  }

  const datum = useMemo(() => tree.nodes.length > 0 ? focusTreeData(tree, collapsed) : null, [tree, collapsed]);
  const cardByNode = useMemo(() => {
    const map = new Map<string, EmergenceCardDto>();
    for (const card of cards) {
      if (card.nodeRef && !map.has(card.nodeRef)) map.set(card.nodeRef, card);
    }
    return map;
  }, [cards]);

  const stripSubject = selectedNodeRef && tree.byId.has(selectedNodeRef)
    ? selectedNodeRef
    : (tree.byId.has(rootRef) ? rootRef : null);
  const stripNode = stripSubject !== null ? tree.byId.get(stripSubject) ?? null : null;
  const stripCard = stripSubject !== null ? cardByNode.get(stripSubject) ?? null : null;

  // 点击语义走最新闭包（图实例只建一次）：收起的中级节点=点开并选中（展开为相机中心）；
  // 已展开但没选中的=只选中不收起（从别的节点点回来不会把开着的子级合上）；
  // 已选中且展开的再点一次=收起并取消选中；根/叶子=只选中。
  const clickRef = useRef<(id: string) => void>(() => {});
  clickRef.current = useCallback((id: string) => {
    const node = tree.byId.get(id);
    if (!node) return;
    const willSelect = selectedNodeRef !== id;
    const middle = node.hasChildren && id !== tree.rootId;
    const open = middle && !collapsed.has(id);
    if (middle && (!open || !willSelect)) {
      cameraTargetRef.current = id;
      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else if (willSelect) {
      const graph = graphRef.current;
      if (graph && graph.findById(id)) tweenCameraToNode(graph, id, graph.getZoom() || 1, 380);
    }
    onSelectNode(willSelect ? id : null);
  }, [tree, selectedNodeRef, onSelectNode, collapsed]);

  const hasTree = tree.nodes.length > 0;

  // 建图一次（空树时挂载点不存在，出树后再建）；尺寸变化 → 防抖 changeSize + 重布局 + 相机归位
  useEffect(() => {
    const el = mountRef.current;
    if (!el || graphRef.current || !datum) return;
    const graph = createFocusGraph(el, datum, (id) => clickRef.current(id));
    graphRef.current = graph;
    lastDatumRef.current = datum;
    registerLiveGraph(graph);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const apply = () => {
      if (!el.isConnected || !el.clientWidth || !el.clientHeight) return;
      try {
        graph.changeSize(el.clientWidth, el.clientHeight);
        graph.refreshLayout();
        // 挂载即带选中时取景对准被选节点（目标被 datum effect 消费后回落根）
        const anchor = cameraTargetRef.current;
        setCameraOnNode(graph, anchor && graph.findById(anchor) ? anchor : tree.rootId, graph.getZoom() || 1, { x: el.clientWidth / 2, y: visCenterY(graph) });
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
      lastDatumRef.current = null;
    };
    // 建图吃掉当帧数据；后续展开/收起由下方换树 effect 接管
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTree]);

  // 展开/收起/换导图：动画换树 + 相机适配（内容超画布拉远、变少轻微推近）；
  // 相机中心=刚点过的节点，否则根
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !datum || lastDatumRef.current === datum) return;
    lastDatumRef.current = datum;
    const target = cameraTargetRef.current;
    cameraTargetRef.current = null;
    const fitLocal = focusFitRef.current;
    focusFitRef.current = false;
    updateFocusGraph(graph, datum, target && tree.byId.has(target) ? target : tree.rootId, { fitLocal });
  }, [datum, tree]);

  const canvasTools = useMemo(() => ({
    zoomBy: (factor: number) => {
      const graph = graphRef.current;
      if (!graph) return;
      const z = graph.getZoom();
      const next = Math.max(0.2, Math.min(3, (Number.isFinite(z) && z > 0 ? z : 1) * factor));
      tweenCameraTo(graph, next, null, 240);
    },
    fitAll: () => {
      const graph = graphRef.current;
      if (!graph) return;
      animateFitView(graph, 24);
    },
    recenter: () => {
      const graph = graphRef.current;
      if (!graph) return;
      // 回到中心=聚焦当前焦点（没选中回根）：居中它，取景刚好装下父级+它的全部子级
      const target = selectedNodeRef && tree.byId.has(selectedNodeRef) ? selectedNodeRef : tree.rootId;
      const node = tree.byId.get(target);
      if (datum && node && node.hasChildren && target !== tree.rootId && collapsed.has(target)) {
        // 子级还收着：先展开，落定后由换树流程做局部取景
        cameraTargetRef.current = target;
        focusFitRef.current = true;
        setCollapsed((current) => { const next = new Set(current); next.delete(target); return next; });
      } else {
        animateRecenter(graph, target, 380, datum);
      }
    },
  }), [tree, selectedNodeRef, datum, collapsed]);

  if (!hasTree) {
    return <div className="eg-viewport eg-empty">{t('contextRoom:emergence.veinEmpty')}</div>;
  }

  return (
    <div ref={viewportRef} className="eg-viewport" aria-label={t('contextRoom:emergence.veinCanvas')}>
      <div ref={mountRef} className="eg-g6-mount" />
      {showDetail && stripNode ? (
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
                  <button type="button" className="is-primary" onClick={() => onCardAction?.(stripCard)}>
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
