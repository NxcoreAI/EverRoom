import gsap from 'gsap';
import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useLocale } from '../../../../../i18n/LocaleContext';
import type { EmergenceCardDto, EmergenceNodeDto, EmergenceProjectionResultDto } from '../../../../../../../shared/knowledge';
import { clampScale, cubicEdgeGeometry, pinTransform, screenOf } from './cameraMath';
import { GraphCanvasTools } from './GraphCanvasTools';
import { layoutWalkJourney, GAPS, NODE_SIZES, type Point } from './treeLayout';
import { nextHops, type WalkHop, type WalkStation } from './walkModel';
import { prefersReducedMotion, useGraphCamera } from './useGraphCamera';
import { TIMING, useGraphTransition } from './useGraphTransition';

interface WalkEdgeView {
  key: string;
  d: string;
  mid: Point;
  relation: string | null;
  bridgeRoom: string | null;
  state: 'walked' | 'next';
}

interface ExitNodeEntry { kind: 'node'; key: string; node: EmergenceNodeDto | null; card: EmergenceCardDto | null; pos: Point; state: 'current' | 'prev' | 'next'; bridgeRoom: string | null; }
interface ExitEdgeEntry { kind: 'edge'; key: string; d: string; mid: Point; relation: string | null; bridgeRoom: string | null; state: 'walked' | 'next'; }
type ExitEntry = ExitNodeEntry | ExitEdgeEntry;

interface PrevFrame {
  ids: Set<string>;
  positions: Map<string, Point>;
  edgeKeys: Set<string>;
  current: string;
}

const KIND_LABEL_KEY: Record<string, string> = {
  entity: 'contextRoom:emergence.nodeType.entity',
  fact: 'contextRoom:emergence.nodeType.fact',
  document: 'contextRoom:emergence.nodeType.document',
  memory: 'contextRoom:emergence.nodeType.memory',
  wikiPage: 'contextRoom:emergence.nodeType.wikiPage',
  room: 'contextRoom:emergence.nodeType.room',
};

/**
 * 漫步态步进链：走过的站在左（实线，可点截断回去）、当前驻足居中放大、
 * 下一跳候选在右（虚线，点=前进一步）。走到头右列内联「再走一次」。
 */
export function WalkJourneyCanvas({
  result,
  roomId,
  log,
  cards,
  pending = false,
  onStep,
  onBackTo,
  onWalkAgain,
}: {
  result: EmergenceProjectionResultDto;
  roomId: string;
  log: WalkStation[];
  cards: EmergenceCardDto[];
  /** 续走展开中：不亮尽头卡，右列给「正在展开」占位。 */
  pending?: boolean;
  onStep: (nodeRef: string) => void;
  onBackTo: (index: number) => void;
  onWalkAgain: () => void;
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

  const hops = useMemo(() => nextHops(result, roomId, log), [result, roomId, log]);
  const layout = useMemo(() => layoutWalkJourney(log, hops), [log, hops]);
  const nodeById = useMemo(() => new Map(result.nodes.map((node) => [node.id, node])), [result]);
  const cardByNode = useMemo(() => {
    const map = new Map<string, EmergenceCardDto>();
    for (const card of cards) {
      if (card.nodeRef && !map.has(card.nodeRef)) map.set(card.nodeRef, card);
    }
    return map;
  }, [cards]);

  const currentRef = log.length > 0 ? log[log.length - 1].nodeRef : null;

  const edgeViews = useMemo<WalkEdgeView[]>(() => {
    const list: WalkEdgeView[] = [];
    const sizeOf = (id: string): { width: number; height: number } => id === currentRef ? NODE_SIZES.walkCurrent : NODE_SIZES.walkPrev;
    const geometry = (fromId: string, toId: string, station: { viaRelation: string | null; bridgeRoom: string | null }, key: string, state: 'walked' | 'next') => {
      const fromPos = layout.positions.get(fromId);
      const toPos = layout.positions.get(toId);
      if (!fromPos || !toPos) return;
      const fs = sizeOf(fromId);
      const ts = sizeOf(toId);
      const geo = cubicEdgeGeometry(
        { x: fromPos.x + fs.width, y: fromPos.y + fs.height / 2 },
        { x: toPos.x, y: toPos.y + ts.height / 2 },
      );
      list.push({ key, d: geo.d, mid: geo.mid, relation: station.viaRelation, bridgeRoom: station.bridgeRoom, state });
    };
    for (let i = 1; i < log.length; i += 1) {
      geometry(log[i - 1].nodeRef, log[i].nodeRef, log[i], `w:${log[i].nodeRef}`, 'walked');
    }
    for (const hop of hops) {
      geometry(currentRef ?? '', hop.nodeRef, hop, `h:${hop.nodeRef}`, 'next');
    }
    return list;
  }, [log, hops, layout, currentRef]);

  const [exiting, setExiting] = useState<ExitEntry[]>([]);
  const nodeEls = useRef(new Map<string, HTMLElement>());
  const edgeEls = useRef(new Map<string, SVGPathElement>());
  const labelEls = useRef(new Map<string, HTMLSpanElement>());
  const ghostEls = useRef(new Map<string, HTMLElement>());
  const prevRef = useRef<PrevFrame | null>(null);
  const prevEdgeViewsRef = useRef<WalkEdgeView[]>([]);
  const prevStatesRef = useRef<Map<string, ExitNodeEntry['state']>>(new Map());

  const setNodeEl = useCallback((id: string) => (el: HTMLElement | null) => {
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
    const size = id === currentRef ? NODE_SIZES.walkCurrent : NODE_SIZES.walkPrev;
    return { x: pos.x + size.width / 2, y: pos.y + size.height / 2 };
  }, [currentRef]);

  const fadeIn = useCallback((el: Element, delayMs = 0) => {
    if (prefersReducedMotion()) return;
    track(gsap.from(el, { opacity: 0, duration: TIMING.born / 1000, ease: 'power1.out', delay: delayMs / 1000, overwrite: 'auto' }));
  }, [track]);

  const followZoom = useCallback((): number => {
    const vp = viewportSize();
    let toScale = clampScale(camRef.current.scale, 0.5, 1.2);
    const bw = layout.bbox.maxX - layout.bbox.minX;
    const bh = layout.bbox.maxY - layout.bbox.minY;
    if (bw > 0 && bh > 0 && vp.width > 0 && vp.height > 0) {
      const fitZoom = Math.min((vp.width - 56) / bw, (vp.height - 48) / bh);
      toScale = Math.min(toScale, clampScale(fitZoom, 0.45, 1.15));
    }
    return toScale;
  }, [viewportSize, camRef, layout]);

  const canvasTools = useMemo(() => ({
    zoomBy: (factor: number) => {
      const vp = viewportSize();
      if (vp.width <= 0 || vp.height <= 0) return;
      const cam = camRef.current;
      const scale = Number.isFinite(cam.scale) && cam.scale > 0 ? cam.scale : 1;
      const center = { x: vp.width / 2, y: vp.height / 2 };
      const content = { x: (center.x - cam.x) / scale, y: (center.y - cam.y) / scale };
      cancelTween();
      setCam(pinTransform(content.x, content.y, center.x, center.y, clampScale(scale * factor)));
    },
    fitAll: () => {
      cancelTween();
      fit(layout.bbox, 28, 1.15);
    },
    recenter: () => {
      const anchor = currentRef ? anchorOf(currentRef, layout.positions.get(currentRef)) : null;
      if (!anchor) return;
      const vp = viewportSize();
      cancelTween();
      setCam(pinTransform(anchor.x, anchor.y, vp.width / 2, vp.height / 2, camRef.current.scale));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [viewportSize, camRef, cancelTween, setCam, fit, layout, anchorOf, currentRef]);

  useLayoutEffect(() => {
    if (!currentRef || layout.positions.size === 0) {
      setExiting([]);
      prevRef.current = null;
      prevEdgeViewsRef.current = [];
      return;
    }
    const gen = next();
    const vp = viewportSize();
    const newIds = new Set(layout.positions.keys());
    const newEdgeKeys = new Set(edgeViews.map((edge) => edge.key));
    const reduced = prefersReducedMotion();
    const prev = prevRef.current;

    if (!prev || prev.ids.size === 0) {
      setExiting([]);
      fit(layout.bbox, 28, 1.15);
      if (!reduced) {
        const cp = anchorOf(currentRef, layout.positions.get(currentRef));
        let index = 0;
        for (const station of log) {
          const el = nodeEls.current.get(station.nodeRef);
          const pos = layout.positions.get(station.nodeRef);
          if (!el || !pos || !cp) continue;
          const size = station.nodeRef === currentRef ? NODE_SIZES.walkCurrent : NODE_SIZES.walkPrev;
          bornFrom(el, { x: cp.x - (pos.x + size.width / 2), y: cp.y - (pos.y + size.height / 2) }, Math.min(index * TIMING.stagger, TIMING.staggerCap));
          index += 1;
        }
      }
      prevEdgeViewsRef.current = edgeViews;
      prevStatesRef.current = new Map(log.map((station, index) => [station.nodeRef, index === log.length - 1 ? 'current' : 'prev']));
      prevRef.current = { ids: newIds, positions: new Map(layout.positions), edgeKeys: newEdgeKeys, current: currentRef };
      return;
    }

    const anchor = anchorOf(currentRef, layout.positions.get(currentRef));
    const currentChanged = prev.current !== currentRef;

    // 钉屏：新的当前站钉回它的旧屏幕位（刚点的下一跳卡就在那），再短补间到中心。
    // 仅驻足真变化时执行——同驻足的重跑（StrictMode/刷新）再钉屏会杀掉进行中的相机补间。
    if (anchor && currentChanged) {
      const oldPos = prev.positions.get(currentRef);
      const oldSize = prevStatesRef.current.get(currentRef) === 'current' ? NODE_SIZES.walkCurrent : NODE_SIZES.walkNext;
      let sp = oldPos ? screenOf(oldPos.x + oldSize.width / 2, oldPos.y + oldSize.height / 2, camRef.current) : null;
      if (!sp || sp.x < 0 || sp.x > vp.width || sp.y < 0 || sp.y > vp.height) sp = visualCenter(0);
      cancelTween();
      setCam(pinTransform(anchor.x, anchor.y, sp.x, sp.y, camRef.current.scale));
    }

    if (!reduced) {
      const ghosts: ExitEntry[] = [];
      for (const [id, pos] of prev.positions) {
        if (newIds.has(id)) continue;
        const node = nodeById.get(id) ?? null;
        const state = prevStatesRef.current.get(id) ?? 'next';
        ghosts.push({ kind: 'node', key: `n:${id}`, node, card: cardByNode.get(id) ?? null, pos, state, bridgeRoom: null });
      }
      for (const edge of prevEdgeViewsRef.current) {
        if (!newEdgeKeys.has(edge.key)) ghosts.push({ kind: 'edge', ...edge });
      }
      setExiting(ghosts);
    } else {
      setExiting([]);
    }

    let bornIndex = 0;
    for (const id of newIds) {
      const el = nodeEls.current.get(id);
      const pos = layout.positions.get(id);
      if (!el || !pos) continue;
      const size = id === currentRef ? NODE_SIZES.walkCurrent : NODE_SIZES.walkNext;
      const from = prev.positions.get(id);
      if (from) {
        if (from.x !== pos.x || from.y !== pos.y) {
          morphFrom(el, { x: from.x - pos.x, y: from.y - pos.y }, TIMING.morph, 'power3.out');
        }
      } else if (anchor) {
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

    if (anchor) {
      if (currentChanged) {
        tweenTo(anchor, followZoom(), { durationMs: TIMING.walkCamera });
        later(gen, () => ensureVisible(anchor, layout.bbox, 0), TIMING.recenter);
        later(gen, () => ensureVisible(anchor, layout.bbox, 0), TIMING.watchdog);
      } else {
        later(gen, () => ensureVisible(anchor, layout.bbox, 0), TIMING.recenter);
      }
    }

    prevEdgeViewsRef.current = edgeViews;
    prevStatesRef.current = new Map(log.map((station, index) => [station.nodeRef, index === log.length - 1 ? 'current' : 'prev']));
    for (const hop of hops) prevStatesRef.current.set(hop.nodeRef, 'next');
    prevRef.current = { ids: newIds, positions: new Map(layout.positions), edgeKeys: newEdgeKeys, current: currentRef };
  }, [
    log, hops, layout, edgeViews, currentRef, nodeById, cardByNode,
    next, later, fit, tweenTo, cancelTween, ensureVisible, setCam, viewportSize, visualCenter, camRef,
    anchorOf, followZoom, morphFrom, bornFrom, fadeIn,
  ]);

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

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      const anchor = currentRef ? anchorOf(currentRef, layout.positions.get(currentRef)) : null;
      if (anchor) ensureVisible(anchor, layout.bbox, 0);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [layout, currentRef, anchorOf, ensureVisible]);

  if (!currentRef || layout.positions.size === 0) {
    return <div className="eg-viewport eg-empty">{t('contextRoom:emergence.veinEmpty')}</div>;
  }

  const kindLabel = (nodeType: string): string => KIND_LABEL_KEY[nodeType] ? t(KIND_LABEL_KEY[nodeType]) : nodeType;

  const renderStation = (
    id: string,
    pos: Point,
    size: { width: number; height: number },
    state: 'current' | 'prev' | 'next',
    station: WalkStation | WalkHop | null,
    onClick: (() => void) | undefined,
    ghost: boolean,
  ) => {
    const node = nodeById.get(id) ?? null;
    const card = cardByNode.get(id) ?? null;
    const label = node?.label ?? id;
    const bridgeRoom = station?.bridgeRoom ?? null;
    const deadEnd = state === 'next' && (station as WalkHop | null)?.deadEnd === true;
    const inner = (
      <>
        <header>
          <span className="eg-walk-kind">{node ? kindLabel(node.nodeType) : ''}</span>
          {bridgeRoom ? <span className="eg-walk-bridge">{bridgeRoom}</span> : null}
          {deadEnd ? <span className="eg-walk-dead">{t('contextRoom:emergence.wanderDeadEnd')}</span> : null}
        </header>
        <strong>{label}</strong>
        {card ? <p>{card.summary}</p> : null}
      </>
    );
    const className = `eg-walk is-${state}${deadEnd ? ' is-dead' : ''}${ghost ? ' is-exiting' : ''}`;
    const style = { left: pos.x, top: pos.y, width: size.width, height: size.height };
    if (state === 'current') {
      return (
        <article key={ghost ? `g:${id}` : id} ref={ghost ? setGhostEl(`n:${id}`) : setNodeEl(id)} data-eg-node="" data-kind={node?.nodeType} className={className} style={style} title={label}>
          {inner}
        </article>
      );
    }
    return (
      <button
        key={ghost ? `g:${id}` : id}
        ref={ghost ? setGhostEl(`n:${id}`) : setNodeEl(id)}
        type="button"
        data-eg-node=""
        data-kind={node?.nodeType}
        className={className}
        style={style}
        title={label}
        tabIndex={ghost ? -1 : undefined}
        onClick={ghost ? undefined : onClick}
      >
        {inner}
      </button>
    );
  };

  const currentPos = layout.positions.get(currentRef)!;
  // 右列空槽：续走展开中给「正在展开」占位（不亮尽头卡）；确定无下一跳才亮尽头卡。
  const emptySlotPos = layout.positions.size > 0 && hops.length === 0
    ? {
        x: NODE_SIZES.walkCurrent.width + GAPS.walkH,
        y: (NODE_SIZES.walkCurrent.height - NODE_SIZES.walkNext.height) / 2,
      }
    : null;
  const pendingSlot = pending && emptySlotPos;
  const stuckPos = !pending && emptySlotPos;

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
              className={`eg-edge is-${edge.state}${edge.bridgeRoom ? ' is-bridge' : ''}`}
              style={{ d: `path('${edge.d}')` }}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {edgeViews.filter((edge) => edge.relation).map((edge) => (
          <span
            key={`l:${edge.key}`}
            ref={setLabelEl(edge.key)}
            className={`eg-edge-label is-${edge.state}${edge.bridgeRoom ? ' is-bridge' : ''}`}
            style={{ left: edge.mid.x, top: edge.mid.y }}
          >
            {edge.relation}
            {edge.bridgeRoom ? <em> · {edge.bridgeRoom}</em> : null}
          </span>
        ))}
        {log.map((station, index) => {
          const pos = layout.positions.get(station.nodeRef);
          if (!pos) return null;
          if (index === log.length - 1) {
            return renderStation(station.nodeRef, pos, NODE_SIZES.walkCurrent, 'current', station, undefined, false);
          }
          return renderStation(station.nodeRef, pos, NODE_SIZES.walkPrev, 'prev', station, () => onBackTo(index), false);
        })}
        {hops.map((hop) => {
          const pos = layout.positions.get(hop.nodeRef);
          return pos ? renderStation(hop.nodeRef, pos, NODE_SIZES.walkNext, 'next', hop, () => onStep(hop.nodeRef), false) : null;
        })}
        {stuckPos ? (
          <div className="eg-walk is-stuck" data-eg-node="" style={{ left: stuckPos.x, top: stuckPos.y, width: NODE_SIZES.walkNext.width, height: NODE_SIZES.walkNext.height }}>
            <p>{t('contextRoom:emergence.wanderNoNext')}</p>
            <button type="button" onClick={onWalkAgain}>
              <RotateCcw aria-hidden="true" />
              {t('contextRoom:emergence.wanderAgain')}
            </button>
          </div>
        ) : null}
        {pendingSlot ? (
          <div className="eg-walk is-pending" data-eg-node="" style={{ left: pendingSlot.x, top: pendingSlot.y, width: NODE_SIZES.walkNext.width, height: NODE_SIZES.walkNext.height }}>
            <p>{t('contextRoom:emergence.wanderExtending')}</p>
          </div>
        ) : null}
        {exiting.length > 0 ? (
          <div className="eg-ghosts" aria-hidden="true">
            <svg className="eg-edges">
              {exitEdges.map((edge) => (
                <path key={edge.key} d={edge.d} className={`eg-edge is-${edge.state} is-exiting`} vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
            {exitEdges.filter((edge) => edge.relation).map((edge) => (
              <span key={`l:${edge.key}`} className={`eg-edge-label is-${edge.state} is-exiting`} style={{ left: edge.mid.x, top: edge.mid.y }}>
                {edge.relation}
                {edge.bridgeRoom ? <em> · {edge.bridgeRoom}</em> : null}
              </span>
            ))}
            {exitNodes.map((entry) => renderStation(
              entry.key.slice(2),
              entry.pos,
              entry.state === 'current' ? NODE_SIZES.walkCurrent : entry.state === 'prev' ? NODE_SIZES.walkPrev : NODE_SIZES.walkNext,
              entry.state,
              null,
              undefined,
              true,
            ))}
          </div>
        ) : null}
      </div>
      <GraphCanvasTools actions={canvasTools} />
    </div>
  );
}
