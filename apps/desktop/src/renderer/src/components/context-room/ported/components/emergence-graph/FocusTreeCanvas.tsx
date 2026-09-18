import gsap from 'gsap';
import { ArrowLeft, ChevronDown, ChevronUp, ListTree, Plus, Quote } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useLocale } from '../../../../../i18n/LocaleContext';
import type { EmergenceCardDto, EmergenceProjectionResultDto } from '../../../../../../../shared/knowledge';
import { clampScale, cubicEdgeGeometry, pinTransform, screenOf } from './cameraMath';
import { GraphCanvasTools } from './GraphCanvasTools';
import { buildFocusSubtree, type FocusTreeNode } from './focusTreeModel';
import { layoutFocusTree, NODE_SIZES, treeRoleOf, treeRoleSize, type Point } from './treeLayout';
import { prefersReducedMotion, useGraphCamera } from './useGraphCamera';
import { TIMING, useGraphTransition } from './useGraphTransition';

interface EdgeView {
  key: string;
  d: string;
  mid: Point;
  relation: string | null;
  isReturn: boolean;
}

interface ExitNodeEntry { kind: 'node'; key: string; node: FocusTreeNode; pos: Point; }
interface ExitEdgeEntry { kind: 'edge'; key: string; d: string; mid: Point; relation: string | null; isReturn: boolean; }
type ExitEntry = ExitNodeEntry | ExitEdgeEntry;

interface PrevFrame {
  ids: Set<string>;
  positions: Map<string, Point>;
  nodes: Map<string, FocusTreeNode>;
  edgeKeys: Set<string>;
  center: string;
}

const STRIP_RESERVE = 96;

/**
 * 聚焦态树状导图：两层邻域胶囊卡 + SVG 连线；点非中心节点=钻取换根（压栈），
 * 回程框/头部箭头=在历史栈上回退前进；底部详情条随选中/中心联动，可跳卡片流。
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
  const cameraElRef = useRef<HTMLDivElement>(null);
  const camera = useGraphCamera(viewportRef, cameraElRef);
  const transition = useGraphTransition();
  const {
    camRef, setCam, fit, tweenTo, cancelTween, ensureVisible, viewportSize, visualCenter,
  } = camera;
  const { next, later, alive, track, morphFrom, bornFrom, fadeOutEl } = transition;

  const subtree = useMemo(() => buildFocusSubtree(result, centerRef, returnRef), [result, centerRef, returnRef]);
  const nodeById = useMemo(() => new Map(subtree.nodes.map((node) => [node.id, node])), [subtree]);
  const layout = useMemo(() => layoutFocusTree(subtree.nodes), [subtree]);
  const cardByNode = useMemo(() => {
    const map = new Map<string, EmergenceCardDto>();
    for (const card of cards) {
      if (card.nodeRef && !map.has(card.nodeRef)) map.set(card.nodeRef, card);
    }
    return map;
  }, [cards]);

  const edgeViews = useMemo<EdgeView[]>(() => {
    const list: EdgeView[] = [];
    for (const node of subtree.nodes) {
      if (!node.parentId) continue;
      const parent = nodeById.get(node.parentId);
      const parentPos = layout.positions.get(node.parentId);
      const pos = layout.positions.get(node.id);
      if (!parent || !parentPos || !pos) continue;
      const ps = treeRoleSize(parent);
      const cs = treeRoleSize(node);
      const from = node.isReturn
        ? { x: parentPos.x, y: parentPos.y + ps.height / 2 }
        : { x: parentPos.x + ps.width, y: parentPos.y + ps.height / 2 };
      const to = node.isReturn
        ? { x: pos.x + cs.width, y: pos.y + cs.height / 2 }
        : { x: pos.x, y: pos.y + cs.height / 2 };
      const geo = cubicEdgeGeometry(from, to);
      list.push({
        key: `e:${node.id}`,
        d: geo.d,
        mid: geo.mid,
        relation: node.via?.relationType ?? null,
        isReturn: node.isReturn,
      });
    }
    return list;
  }, [subtree, nodeById, layout]);

  const [exiting, setExiting] = useState<ExitEntry[]>([]);
  const [stripCollapsed, setStripCollapsed] = useState(false);
  const [stripHeight, setStripHeight] = useState(STRIP_RESERVE);
  const stripElRef = useRef<HTMLDivElement | null>(null);
  const nodeEls = useRef(new Map<string, HTMLButtonElement>());
  const edgeEls = useRef(new Map<string, SVGPathElement>());
  const labelEls = useRef(new Map<string, HTMLSpanElement>());
  const ghostEls = useRef(new Map<string, HTMLElement>());
  const prevRef = useRef<PrevFrame | null>(null);
  const prevEdgeViewsRef = useRef<EdgeView[]>([]);

  const setNodeEl = useCallback((id: string) => (el: HTMLButtonElement | null) => {
    if (el) nodeEls.current.set(id, el);
    else nodeEls.current.delete(id);
  }, []);
  const setEdgeEl = useCallback((key: string) => (el: SVGPathElement | null) => {
    if (el) edgeEls.current.set(key, el);
    else edgeEls.current.delete(key);
  }, []);
  const setLabelEl = useCallback((key: string) => (el: HTMLSpanElement | null) => {
    if (el) labelEls.current.set(key, el);
    else labelEls.current.delete(key);
  }, []);
  const setGhostEl = useCallback((key: string) => (el: HTMLElement | null) => {
    if (el) ghostEls.current.set(key, el);
    else ghostEls.current.delete(key);
  }, []);

  const anchorOf = useCallback((id: string, pos: Point | undefined): Point | null => {
    if (!pos) return null;
    const node = nodeById.get(id);
    const size = node ? treeRoleSize(node) : NODE_SIZES.center;
    return { x: pos.x + size.width / 2, y: pos.y + size.height / 2 };
  }, [nodeById]);

  const stripSubject = selectedNodeRef && nodeById.has(selectedNodeRef)
    ? selectedNodeRef
    : (nodeById.has(centerRef) ? centerRef : null);
  const stripNode = stripSubject !== null ? nodeById.get(stripSubject) ?? null : null;
  const stripCard = stripSubject !== null ? cardByNode.get(stripSubject) ?? null : null;
  const stripReserve = stripNode ? Math.min(Math.max(stripHeight + 24, 72), 300) : 0;
  const bottomReserve = stripReserve;

  // 详情卡实际高度 → 相机视觉中心上移量（折叠/换卡后相机随之校准）
  useEffect(() => {
    const el = stripElRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setStripHeight(el.offsetHeight);
    });
    observer.observe(el);
    setStripHeight(el.offsetHeight);
    return () => observer.disconnect();
  }, [stripSubject, stripCollapsed]);

  const fadeIn = useCallback((el: Element, delayMs = 0) => {
    if (prefersReducedMotion()) return;
    track(gsap.from(el, { opacity: 0, duration: TIMING.born / 1000, ease: 'power1.out', delay: delayMs / 1000, overwrite: 'auto' }));
  }, [track]);

  const drillZoom = useCallback((): number => {
    const vp = viewportSize();
    let toScale = clampScale(camRef.current.scale * 1.12, 0.85, 1.1);
    const bw = layout.bbox.maxX - layout.bbox.minX;
    const bh = layout.bbox.maxY - layout.bbox.minY;
    if (bw > 0 && bh > 0 && vp.width > 0 && vp.height > 0) {
      const fitZoom = Math.min((vp.width - 56) / bw, (vp.height - 40 - bottomReserve) / bh);
      toScale = Math.min(toScale, clampScale(fitZoom, 0.45, 1.15));
    }
    return toScale;
  }, [viewportSize, camRef, layout, bottomReserve]);

  const canvasTools = useMemo(() => ({
    zoomBy: (factor: number) => {
      const vp = viewportSize();
      if (vp.width <= 0 || vp.height <= 0) return;
      const cam = camRef.current;
      const scale = Number.isFinite(cam.scale) && cam.scale > 0 ? cam.scale : 1;
      const center = { x: vp.width / 2, y: Math.max(40, (vp.height - bottomReserve) / 2) };
      const content = { x: (center.x - cam.x) / scale, y: (center.y - cam.y) / scale };
      cancelTween();
      setCam(pinTransform(content.x, content.y, center.x, center.y, clampScale(scale * factor)));
    },
    fitAll: () => {
      cancelTween();
      fit(layout.bbox, 28, 1.15);
    },
    recenter: () => {
      const anchor = anchorOf(centerRef, layout.positions.get(centerRef));
      if (!anchor) return;
      const vp = viewportSize();
      cancelTween();
      setCam(pinTransform(anchor.x, anchor.y, vp.width / 2, Math.max(40, (vp.height - bottomReserve) / 2), camRef.current.scale));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [viewportSize, camRef, cancelTween, setCam, fit, layout, anchorOf, centerRef, bottomReserve]);

  // 钻取五步编排（提交后、绘制前）：钉屏换树 → 退场鬼影 → 存活变形 → 新生错峰 → 相机补间+看门狗。
  // 快速连点靠代数计数器整体作废上一代补间；正确性不依赖动画（终态即布局+ensureVisible）。
  useLayoutEffect(() => {
    if (subtree.nodes.length === 0) {
      setExiting([]);
      prevRef.current = null;
      prevEdgeViewsRef.current = [];
      return;
    }
    const gen = next();
    const vp = viewportSize();
    const reserve = bottomReserve;
    const newIds = new Set(layout.positions.keys());
    const newEdgeKeys = new Set(edgeViews.map((edge) => edge.key));
    const reduced = prefersReducedMotion();
    const prev = prevRef.current;

    if (!prev || prev.ids.size === 0) {
      setExiting([]);
      fit(layout.bbox, 28, 1.15);
      if (!reduced) {
        const cp = anchorOf(centerRef, layout.positions.get(centerRef));
        let index = 0;
        for (const node of subtree.nodes) {
          const el = nodeEls.current.get(node.id);
          const pos = layout.positions.get(node.id);
          if (!el || !pos || !cp || node.isReturn) continue;
          const size = treeRoleSize(node);
          const from = node.id === centerRef
            ? { x: 0, y: 0 }
            : { x: cp.x - (pos.x + size.width / 2), y: cp.y - (pos.y + size.height / 2) };
          bornFrom(el, from, Math.min(index * TIMING.stagger, TIMING.staggerCap));
          index += 1;
        }
      }
      prevEdgeViewsRef.current = edgeViews;
      prevRef.current = { ids: newIds, positions: new Map(layout.positions), nodes: nodeById, edgeKeys: newEdgeKeys, center: centerRef };
      return;
    }

    const anchor = anchorOf(centerRef, layout.positions.get(centerRef));
    const centerChanged = prev.center !== centerRef;

    // 钉屏：新中心钉回旧屏幕位（旧位出画/未知钉视觉中心），点击的卡在换树瞬间不跳。
    // 仅中心真变化时执行——同中心的数据刷新重跑 effect 时若再钉屏，会杀掉进行中的相机补间。
    if (anchor && centerChanged) {
      const oldPos = prev.positions.get(centerRef);
      const oldNode = prev.nodes.get(centerRef);
      const oldSize = oldNode ? treeRoleSize(oldNode) : NODE_SIZES.center;
      let sp = oldPos ? screenOf(oldPos.x + oldSize.width / 2, oldPos.y + oldSize.height / 2, camRef.current) : null;
      if (!sp || sp.x < 0 || sp.x > vp.width || sp.y < 0 || sp.y > vp.height) sp = visualCenter(reserve);
      cancelTween();
      setCam(pinTransform(anchor.x, anchor.y, sp.x, sp.y, camRef.current.scale));
    }

    // 退场集合：旧有新无的节点/边以旧坐标多留一阵，独立 effect 渐隐
    if (!reduced) {
      const ghosts: ExitEntry[] = [];
      for (const node of prev.nodes.values()) {
        if (newIds.has(node.id)) continue;
        const pos = prev.positions.get(node.id);
        if (pos) ghosts.push({ kind: 'node', key: `n:${node.id}`, node, pos });
      }
      for (const edge of prevEdgeViewsRef.current) {
        if (!newEdgeKeys.has(edge.key)) ghosts.push({ kind: 'edge', ...edge });
      }
      setExiting(ghosts);
    } else {
      setExiting([]);
    }

    // 存活节点从旧位变形而来；新生节点从中心长出（45ms 错峰，封顶 180ms）
    let bornIndex = 0;
    for (const node of subtree.nodes) {
      const el = nodeEls.current.get(node.id);
      const pos = layout.positions.get(node.id);
      if (!el || !pos) continue;
      const size = treeRoleSize(node);
      const from = prev.positions.get(node.id);
      if (from) {
        if (from.x !== pos.x || from.y !== pos.y) {
          morphFrom(el, { x: from.x - pos.x, y: from.y - pos.y }, TIMING.morph, 'power3.out');
        }
      } else if (anchor && !node.isReturn) {
        bornFrom(el, { x: anchor.x - (pos.x + size.width / 2), y: anchor.y - (pos.y + size.height / 2) }, Math.min(bornIndex * TIMING.stagger, TIMING.staggerCap));
        bornIndex += 1;
      }
    }
    for (const edge of edgeViews) {
      if (prev.edgeKeys.has(edge.key)) continue;
      const el = edgeEls.current.get(edge.key);
      if (el) fadeIn(el, TIMING.stagger);
      const label = labelEls.current.get(`l:${edge.key}`);
      if (label) fadeIn(label, TIMING.stagger);
    }

    // 相机：钻取推近到新中心；同中心的数据刷新只对中不推近
    if (anchor) {
      if (centerChanged) {
        tweenTo(anchor, drillZoom(), { durationMs: TIMING.camera, bottomReserve: reserve });
        later(gen, () => ensureVisible(anchor, layout.bbox, reserve), TIMING.recenter);
        later(gen, () => ensureVisible(anchor, layout.bbox, reserve), TIMING.watchdog);
      } else {
        later(gen, () => ensureVisible(anchor, layout.bbox, reserve), TIMING.recenter);
      }
    }

    prevEdgeViewsRef.current = edgeViews;
    prevRef.current = { ids: newIds, positions: new Map(layout.positions), nodes: nodeById, edgeKeys: newEdgeKeys, center: centerRef };
  }, [
    subtree, nodeById, layout, edgeViews, centerRef, bottomReserve,
    next, later, fit, tweenTo, cancelTween, ensureVisible, setCam, viewportSize, visualCenter, camRef,
    anchorOf, drillZoom, morphFrom, bornFrom, fadeIn,
  ]);

  // 退场鬼影渐隐 + 兜底清理（代数守卫：新一轮编排会重设集合，旧清理不误伤）
  useEffect(() => {
    if (exiting.length === 0) return;
    const gen = transition.genRef.current;
    for (const entry of exiting) {
      const el = ghostEls.current.get(entry.key);
      if (el) fadeOutEl(el);
    }
    const timer = window.setTimeout(() => {
      if (alive(gen)) setExiting([]);
    }, TIMING.fadeOutBackstop);
    return () => clearTimeout(timer);
  }, [exiting, fadeOutEl, alive, transition.genRef]);

  // 视口尺寸变化（含 companion 收窄）：保中心可见
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      const anchor = anchorOf(centerRef, layout.positions.get(centerRef));
      if (anchor) ensureVisible(anchor, layout.bbox, bottomReserve);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [layout, centerRef, bottomReserve, anchorOf, ensureVisible]);

  const handleNodeClick = (node: FocusTreeNode) => {
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
  };

  if (subtree.nodes.length === 0) {
    return <div className="eg-viewport eg-empty">{t('contextRoom:emergence.veinEmpty')}</div>;
  }

  const renderNode = (node: FocusTreeNode, pos: Point, ghost: boolean) => {
    const size = treeRoleSize(node);
    const role = treeRoleOf(node);
    const selected = !ghost && node.id === selectedNodeRef && node.id !== centerRef;
    return (
      <button
        key={ghost ? `g:${node.id}` : node.id}
        ref={ghost ? setGhostEl(`n:${node.id}`) : setNodeEl(node.id)}
        type="button"
        data-eg-node=""
        data-kind={node.node.nodeType}
        data-role={role}
        className={`eg-node${selected ? ' is-selected' : ''}${ghost ? ' is-exiting' : ''}`}
        style={{ left: pos.x, top: pos.y, width: size.width, height: size.height }}
        title={node.isReturn ? t('contextRoom:emergence.returnToParent') : node.node.label}
        tabIndex={ghost ? -1 : undefined}
        onClick={ghost ? undefined : () => handleNodeClick(node)}
      >
        {node.isReturn ? <ArrowLeft className="eg-node-return-icon" aria-hidden="true" /> : null}
        <span className="eg-node-label">{node.node.label}</span>
        {node.expandable && !node.isReturn && node.id !== centerRef ? <Plus className="eg-node-plus" aria-hidden="true" /> : null}
      </button>
    );
  };

  const exitNodes = exiting.filter((entry): entry is ExitNodeEntry => entry.kind === 'node');
  const exitEdges = exiting.filter((entry): entry is ExitEdgeEntry => entry.kind === 'edge');

  return (
    <div ref={viewportRef} className="eg-viewport" aria-label={t('contextRoom:emergence.veinCanvas')}>
      <div ref={cameraElRef} className="eg-camera">
        <svg className="eg-edges" aria-hidden="true">
          {edgeViews.map((edge) => (
            <path
              key={edge.key}
              ref={setEdgeEl(edge.key)}
              d={edge.d}
              className={`eg-edge${edge.isReturn ? ' is-return' : ''}`}
              style={{ d: `path('${edge.d}')` }}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {edgeViews.filter((edge) => edge.relation).map((edge) => (
          <span
            key={`l:${edge.key}`}
            ref={setLabelEl(edge.key)}
            className={`eg-edge-label${edge.isReturn ? ' is-return' : ''}`}
            style={{ left: edge.mid.x, top: edge.mid.y }}
          >
            {edge.relation}
          </span>
        ))}
        {subtree.nodes.map((node) => {
          const pos = layout.positions.get(node.id);
          return pos ? renderNode(node, pos, false) : null;
        })}
        {exiting.length > 0 ? (
          <div className="eg-ghosts" aria-hidden="true">
            <svg className="eg-edges">
              {exitEdges.map((edge) => (
                <path key={edge.key} d={edge.d} className="eg-edge is-exiting" vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
            {exitEdges.filter((edge) => edge.relation).map((edge) => (
              <span key={`l:${edge.key}`} className="eg-edge-label is-exiting" style={{ left: edge.mid.x, top: edge.mid.y }}>
                {edge.relation}
              </span>
            ))}
            {exitNodes.map((entry) => renderNode(entry.node, entry.pos, true))}
          </div>
        ) : null}
      </div>
      {stripNode ? (
        <div
          ref={stripElRef}
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
