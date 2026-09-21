import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TreeGraph } from '@antv/g6';

import { useLocale } from '../../../../../i18n/LocaleContext';
import type { EmergenceCardDto, EmergenceProjectionResultDto } from '../../../../../../../shared/knowledge';
import { GraphCanvasTools } from './GraphCanvasTools';
import { buildFocusTree } from './focusTreeModel';
import {
  animateFitView, animateRecenter, createFocusGraph, focusTreeData, frameInitialFocused,
  registerLiveGraph, resizeFocusGraph, tweenCameraTo, tweenCameraToNode, unregisterLiveGraph,
  updateFocusGraph,
} from './g6FocusGraph';

/**
 * 写作路线导图画布：全展树（路径链+当前分岔），点击原样上抛由父层解释
 * （路径上级=回退、尾节点子级=续生）。续层生成中在目标节点下挂骨架占位子级
 * （pending），生成完成后骨架淡出、真实选项渐显。底部详情条显示路线理由。
 */
export function FocusTreeCanvas({
  result,
  rootRef,
  selectedNodeRef,
  cards,
  pending,
  onSelectNode,
}: {
  result: EmergenceProjectionResultDto;
  /** 树根（路线根节点）。 */
  rootRef: string;
  selectedNodeRef: string | null;
  cards: EmergenceCardDto[];
  /** 续层生成中：在该节点下挂骨架占位子级（生成动画）。 */
  pending?: { parentRef: string } | null;
  onSelectNode: (nodeRef: string | null) => void;
}) {
  const { t } = useLocale();
  const viewportRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<TreeGraph | null>(null);
  const lastDatumRef = useRef<ReturnType<typeof focusTreeData> | null>(null);
  const [stripCollapsed, setStripCollapsed] = useState(false);

  const tree = useMemo(() => buildFocusTree(result, rootRef), [result, rootRef]);

  // 相机中心目标：换树 datum effect 消费后清空
  const cameraTargetRef = useRef<string | null>(null);
  // 最新选中：resize 重取景读活值（挂载 effect 闭包里的 selectedNodeRef 是挂载时的旧值，
  // 回退/换选后一 resize 镜头就被拽回旧选中）
  const latestSelRef = useRef<string | null>(selectedNodeRef);
  latestSelRef.current = selectedNodeRef;

  // 选中变化：相机对准被选节点（图未建好时挂到 cameraTarget，建图时消费）
  const [prevSelected, setPrevSelected] = useState<string | null>(null);
  if (selectedNodeRef !== prevSelected) {
    setPrevSelected(selectedNodeRef);
    if (selectedNodeRef !== null && tree.byId.has(selectedNodeRef)) {
      cameraTargetRef.current = selectedNodeRef;
      const graph = graphRef.current;
      if (graph && graph.findById(selectedNodeRef)) tweenCameraToNode(graph, selectedNodeRef, graph.getZoom() || 1, 380);
    }
  }

  const datum = useMemo(
    () => tree.nodes.length > 0 ? focusTreeData(tree, pending && tree.byId.has(pending.parentRef) ? pending : null) : null,
    [tree, pending],
  );
  // 内容指纹：轮询会带来内容不变的新对象，指纹相同则不重放换树动画/相机。
  const contentKey = useMemo(() => [
    tree.nodes.map((n) => `${n.id}|${n.node.label}`).join(','),
    result.edges.map((e) => `${e.from}>${e.to}`).join(','),
    pending?.parentRef ?? '',
  ].join('#'), [tree, result, pending]);
  const contentKeyRef = useRef<string | null>(null);

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

  // 点击语义走最新闭包（图实例只建一次）：相机轻推过去 + 上抛给父层解释。
  const clickRef = useRef<(id: string) => void>(() => {});
  clickRef.current = (id: string) => {
    if (!tree.byId.has(id)) return;
    const graph = graphRef.current;
    if (graph && graph.findById(id)) tweenCameraToNode(graph, id, graph.getZoom() || 1, 380);
    onSelectNode(id);
  };

  const hasTree = tree.nodes.length > 0;

  // 建图一次（空树时挂载点不存在，出树后再建）；尺寸变化 → 防抖 changeSize + 重布局 + 相机平滑归位
  useEffect(() => {
    const el = mountRef.current;
    if (!el || graphRef.current || !datum) return;
    const graph = createFocusGraph(el, datum, (id) => clickRef.current(id));
    graphRef.current = graph;
    lastDatumRef.current = datum;
    registerLiveGraph(graph);
    // 首帧取景：选中在根（首生成完成）→ 整树适配与骨架树同构；路径已深入（重挂载/进房）
    // → 焦点局部取景，深树不再整树缩成一粒
    const focusId = selectedNodeRef && tree.byId.has(selectedNodeRef) ? selectedNodeRef : tree.rootId;
    setTimeout(() => { try { frameInitialFocused(graph, datum, focusId); } catch { /* 已销毁 */ } }, 40);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const mountedAt = performance.now();
    const apply = () => {
      const prevW = Number(graph.get('width')) || 0;
      const prevH = Number(graph.get('height')) || 0;
      const zoom = graph.getZoom();
      if (!resizeFocusGraph(graph, el)) return;
      // 挂载时面板未布局（0 尺寸，进房/面板切回期常见）首帧取景被跳过或算出废缩放：
      // 真实尺寸到位后重新取景，而不是保留废缩放（表现为整张图缩成一粒）
      if (prevW <= 0 || prevH <= 0 || !Number.isFinite(zoom) || zoom <= 0.06 || performance.now() - mountedAt < 1500) {
        const live = cameraTargetRef.current ?? latestSelRef.current;
        try { frameInitialFocused(graph, datum, live && graph.findById(live) ? live : focusId); } catch { /* 已销毁 */ }
        return;
      }
      const anchor = cameraTargetRef.current ?? latestSelRef.current;
      const target = anchor && graph.findById(anchor) ? anchor : tree.rootId;
      tweenCameraToNode(graph, target, graph.getZoom() || 1, 240);
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
    // 建图吃掉当帧数据；后续换树由下方 datum effect 接管
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTree]);

  // 换导图：动画换树 + 相机对准当前焦点（选中节点，缺省根）按「父级+子树」局部取景；
  // 内容指纹未变（轮询新对象）不重放。fitLocal 取景让新露出的一层恰好在画面内。
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !datum || lastDatumRef.current === datum) return;
    const prevKey = contentKeyRef.current;
    contentKeyRef.current = contentKey;
    lastDatumRef.current = datum;
    if (prevKey !== null && prevKey === contentKey) return;
    const target = cameraTargetRef.current ?? selectedNodeRef;
    cameraTargetRef.current = null;
    updateFocusGraph(graph, datum, target && tree.byId.has(target) ? target : tree.rootId, { fitLocal: true });
  }, [datum, tree, contentKey, selectedNodeRef]);

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
      // 回到中心=聚焦当前焦点（没选中回根）
      const target = selectedNodeRef && tree.byId.has(selectedNodeRef) ? selectedNodeRef : tree.rootId;
      animateRecenter(graph, target, 380, datum);
    },
  }), [tree, selectedNodeRef, datum]);

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
          {stripCollapsed || !stripCard ? null : <p>{stripCard.summary}</p>}
        </div>
      ) : null}
      <GraphCanvasTools actions={canvasTools} />
    </div>
  );
}
