// 原型移植：diagrams/pc_prototype/lib/contextroom.js 的 G6 引擎层（聚焦导图部分）原样复制。
// 聚焦导图 = TreeGraph + compactBox LR + 钻取动画；数据源换成我们的 focusTreeModel。
// 先求与原型像素级一致，代码风格后续再收。
import G6 from '@antv/g6';
import type { TreeGraph } from '@antv/g6';

import type { FocusTree, FocusTreeNode } from './focusTreeModel';

// 原型把运行时字段（__crAnim/__crTween）挂在图实例上，G6 类型面没有，这里放宽
type G6TreeGraph = TreeGraph & { __crAnim?: number; __crTween?: number | null };

export const truncateText = (s: unknown, n: number): string => {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
};

function themeVars() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => (cs.getPropertyValue(name) || '').trim() || fb;
  return {
    brand: v('--nx-brand-500', '#408cf0'),
    brandSoft: v('--nx-brand-soft', 'rgba(64,140,240,0.10)'),
    ok: v('--nx-color-success', '#10b981'),
    text: v('--nx-text-primary', '#1f2937'),
    textSub: v('--nx-text-secondary', '#6b7280'),
  };
}
const KIND_COLOR: Record<string, string> = { doc: '#408cf0', mail: '#f59e0b', meeting: '#8b5cf6', entity: '#10b981', memory: '#6366f1', wiki: '#06b6d4', task: '#ec4899' };
const NODE_TYPE_KIND: Record<string, string> = { document: 'doc', entity: 'entity', memory: 'memory', wikiPage: 'wiki' };

// 文本宽度实测（G6 路径专用；胶囊节点按字宽定尺寸）
const measureText = (() => {
  let ctx: CanvasRenderingContext2D | null = null;
  return (text: string, font: string): number => {
    try {
      ctx = ctx || document.createElement('canvas').getContext('2d');
      if (!ctx) return String(text).length * 12;
      ctx.font = font;
      return ctx.measureText(text).width;
    } catch {
      return String(text).length * 12;
    }
  };
})();

export interface FocusDatum {
  id: string;
  label: string;
  depth: number;
  kind: string;
  width: number;
  height: number;
  type: string;
  size: [number, number];
  style: Record<string, unknown>;
  labelCfg: Record<string, unknown>;
  children: FocusDatum[];
}

// 聚焦导图数据：胶囊节点（文字 + 边框），尺寸/样式烘进 datum。
// NotebookLM 式展开/收起：hasChildren 节点带 ＋/− 后缀，收起的不下发 children。
export function focusTreeData(tree: FocusTree, collapsed: Set<string>): FocusDatum {
  const T = themeVars();
  const toDatum = (n: FocusTreeNode): FocusDatum => {
    const isCenter = n.depth === 0;
    const fs = isCenter ? 13 : n.depth === 1 ? 12 : 11;
    const weight = isCenter ? 700 : 500;
    const mark = n.hasChildren ? (collapsed.has(n.id) ? ' ＋' : ' −') : '';
    const label = truncateText(n.node.label, isCenter ? 10 : n.depth === 1 ? 9 : 8) + mark;
    const w = Math.ceil(measureText(label, `${weight} ${fs}px PingFang SC, Microsoft YaHei, sans-serif`)) + 22;
    const h = isCenter ? 36 : 30;
    const kind = NODE_TYPE_KIND[n.node.nodeType] ?? '';
    const stroke = isCenter ? T.brand : (KIND_COLOR[kind] || '#94a3b8');
    return {
      id: n.id, label, depth: n.depth, kind, width: w, height: h,
      type: 'rect', size: [w, h],
      style: { fill: isCenter ? 'rgba(64,140,240,0.10)' : '#ffffff', stroke, lineWidth: isCenter ? 2 : 1.4, radius: Math.min(10, h / 2), strokeOpacity: 0.9 },
      labelCfg: { position: 'center', style: { fill: isCenter ? T.text : '#3b4656', fontSize: fs, fontWeight: weight } },
      children: collapsed.has(n.id) ? [] : (tree.childrenOf.get(n.id) ?? []).flatMap((id) => {
        const child = tree.byId.get(id);
        return child ? [toDatum(child)] : [];
      }),
    };
  };
  const root = tree.byId.get(tree.rootId);
  if (!root) throw new Error('focus tree has no root datum');
  return toDatum(root);
}

// 根 = 深度 0 的节点
function rootIdOf(graph: G6TreeGraph): string {
  const root = graph.getNodes().find((n) => {
    const m = n.getModel() as unknown as FocusDatum;
    return m.depth === 0;
  });
  return root ? root.getID() : '';
}

// ============================================================
// 切换动画：退场渐隐 → 钉屏换树 → 入场渐显（按深度 stagger）
// rAF 手写补间 + setTimeout 兜底：rAF 冻结（隐藏窗口/节流）时强制收尾
// ============================================================
function collectTreeIds(datum: FocusDatum, acc?: Set<string>): Set<string> {
  acc = acc || new Set<string>();
  if (!datum) return acc;
  acc.add(datum.id);
  (datum.children || []).forEach((c) => collectTreeIds(c, acc));
  return acc;
}

// G6 item 无公开类型面，原型即如此使用
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type G6Item = any;

function fadeItems(graph: G6TreeGraph, items: G6Item[], toOpacity: number, duration: number, stagger = 0): Promise<void[]> {
  return Promise.all(items.map((it, i) => new Promise<void>((res) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { it.get('group').attr('opacity', toOpacity); graph.paint(); } catch { /* 已销毁 */ }
      res();
    };
    const timeout = setTimeout(finish, Math.min(stagger * i, 180) + duration + 160);
    try {
      const group = it.get('group');
      const from = toOpacity === 0 ? (group.attr('opacity') ?? 1) : 0;
      if (toOpacity !== 0) group.attr('opacity', 0);
      const t0 = performance.now() + Math.min(stagger * i, 180);
      const step = () => {
        if (done) return;
        const k = Math.max(0, Math.min(1, (performance.now() - t0) / duration));
        const e = 1 - Math.pow(1 - k, 3);
        try { group.attr('opacity', from + (toOpacity - from) * e); } catch { /* 已销毁 */ }
        if (k < 1) requestAnimationFrame(step);
        else { clearTimeout(timeout); try { graph.paint(); } catch { /* 已销毁 */ } done = true; res(); }
      };
      requestAnimationFrame(step);
    } catch { clearTimeout(timeout); finish(); }
  })));
}

// 位置变形（自驱 rAF，不用 G6 布局动画——其会与手动平移冲突）
function morphPositions(graph: G6TreeGraph, oldPos: Map<string, { x: number; y: number }>, centerId: string, duration = 300) {
  const nodes = graph.getNodes().map((n) => {
    const m = n.getModel() as unknown as { x?: number; y?: number };
    const target = { x: m.x ?? 0, y: m.y ?? 0 };
    const centerModel = graph.findById(centerId)?.getModel() as unknown as { x?: number; y?: number } | undefined;
    const from = oldPos.get(n.getID()) || { x: centerModel?.x ?? 0, y: centerModel?.y ?? 0 };
    return { n, from, target };
  });
  // 先摆回旧位（存活节点），新节点从中心展开
  nodes.forEach(({ n, from }) => { try { const m = n.getModel() as { x: number; y: number }; m.x = from.x; m.y = from.y; } catch { /* 已销毁 */ } });
  try { graph.refreshPositions(); } catch { /* 已销毁 */ }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    nodes.forEach(({ n, target }) => { try { n.getModel().x = target.x; n.getModel().y = target.y; } catch { /* 已销毁 */ } });
    try { graph.refreshPositions(); } catch { /* 已销毁 */ }
  };
  const timeout = setTimeout(finish, duration + 200);
  const t0 = performance.now();
  const step = () => {
    if (done) return;
    const k = Math.max(0, Math.min(1, (performance.now() - t0) / duration));
    const e = 1 - Math.pow(1 - k, 3);
    nodes.forEach(({ n, from, target }) => {
      try {
        n.getModel().x = from.x + (target.x - from.x) * e;
        n.getModel().y = from.y + (target.y - from.y) * e;
      } catch { /* 已销毁 */ }
    });
    try { graph.refreshPositions(); } catch { /* 已销毁 */ }
    if (k < 1) requestAnimationFrame(step);
    else { clearTimeout(timeout); finish(); }
  };
  requestAnimationFrame(step);
}

// 动画版换树：diff 新旧节点 → 退场渐隐 → changeData（钉屏）→ 位置变形 + 新节点渐显
// afterSettle 在新树布局落定后、位置变形开始前调用（此刻量 bbox 才是换树后的真实尺寸）；
// autoCenter=false 时跳过内置居中，由调用方（updateFocusGraph）自己驱动相机
function animatedChangeData(graph: G6TreeGraph, datum: FocusDatum, centerId: string, opts?: { afterSettle?: () => void; autoCenter?: boolean }) {
  graph.__crAnim = (graph.__crAnim || 0) + 1;
  const gen = graph.__crAnim;
  const oldIds = new Set(graph.getNodes().map((n) => n.getID()));
  const oldPos = new Map(graph.getNodes().map((n): [string, { x: number; y: number }] => { const m = n.getModel() as { x?: number; y?: number }; return [n.getID(), { x: m.x ?? 0, y: m.y ?? 0 }]; }));
  const nextIds = collectTreeIds(datum);
  const dying = graph.getNodes().filter((n) => !nextIds.has(n.getID()));
  const dyingEdges = graph.getEdges().filter((e) => dying.some((n) => e.getSource() === n || e.getTarget() === n));
  const finishNow = () => {
    ([...graph.getNodes(), ...graph.getEdges()] as G6Item[]).forEach((it) => {
      try { it.get('group').stopAnimate?.(); it.get('group').attr('opacity', 1); } catch { /* 已销毁 */ }
    });
  };
  if (gen !== graph.__crAnim) { finishNow(); return Promise.resolve(); }
  return Promise.all([
    dying.length ? fadeItems(graph, dying, 0, 130) : Promise.resolve([]),
    dyingEdges.length ? fadeItems(graph, dyingEdges, 0, 130) : Promise.resolve([]),
  ]).then(() => {
    if (gen !== graph.__crAnim) return;
    pinnedChangeData(graph, datum, centerId);
    try { opts?.afterSettle?.(); } catch (err) { console.warn('[CR-G6] afterSettle:', err instanceof Error ? err.message : err); }
    morphPositions(graph, oldPos, centerId, 300);
    // 变形完成后自动居中（迟到 40ms 校准，确保用最终布局坐标）
    if (opts?.autoCenter !== false) {
      setTimeout(() => { try { recenterCamera(graph, centerId, 0.5); } catch { /* 已销毁 */ } }, 360);
    }
    const born = graph.getNodes().filter((n) => !oldIds.has(n.getID()));
    const bornEdges = graph.getEdges().filter((e) => born.some((n) => e.getSource() === n || e.getTarget() === n));
    if (born.length) fadeItems(graph, born, 1, 200, 45);
    if (bornEdges.length) fadeItems(graph, bornEdges, 1, 200, 45);
  });
}

export function createFocusGraph(el: HTMLElement, datum: FocusDatum, onNodeClick: (id: string) => void): G6TreeGraph {
  registerSkeletonCard();
  skeletonLoop();
  const graph = new G6.TreeGraph({
    container: el,
    width: el.clientWidth,
    height: el.clientHeight,
    animate: false,   // 动画全部由相机承担；changeData 瞬时换树（钉屏补偿），避免逐元素补间闪烁
    modes: { default: ['drag-canvas', 'zoom-canvas'] },
    defaultEdge: { type: 'cubic-horizontal', style: { stroke: '#c9d3e0', lineWidth: 1.4 } },
    layout: { type: 'compactBox', direction: 'LR', getId: (d: FocusDatum) => d.id, getHeight: (d: FocusDatum) => d.height || 30, getWidth: (d: FocusDatum) => d.width || 90, getVGap: () => 14, getHGap: () => 40 },
  });
  graph.data(datum);
  graph.render();
  graph.on('node:click', (e: { item: G6Item }) => {
    if (!e.item) return;
    if ((e.item.getModel() as unknown as FocusDatum).type === 'skeleton-card') return;   // 骨架不可点
    onNodeClick(e.item.getID());
  });
  setTimeout(() => {
    try {
      setCameraOnNode(graph, rootIdOf(graph), 1, { x: el.clientWidth / 2, y: visCenterY(graph) });
    } catch { /* 已销毁 */ }
  }, 30);
  return graph;
}

// 可视区几何：底部悬浮详情条占位时（展开/收起都占），可用区域下缘收到条顶。
// 从画布自身所属视口里找条（同屏多画布时 document 全局查询会查到别人的条）。
function visibleViewport(graph: G6TreeGraph): { top: number; bottom: number } {
  const H = (graph && graph.get('height')) || 0;
  let bottom = H;
  try {
    const el = graph.get('canvas')?.get('el') as HTMLElement | null | undefined;
    const card = (el ? el.closest('.eg-viewport') : null)?.querySelector('[data-eg-strip]') as HTMLElement | null;
    if (card && card.offsetHeight > 20) {
      const body = card.closest('.eg-viewport');
      if (body) {
        const cardTop = card.getBoundingClientRect().top - body.getBoundingClientRect().top;
        if (Number.isFinite(cardTop) && cardTop > 60) bottom = cardTop;
      }
    }
  } catch { /* 无 DOM */ }
  return { top: 0, bottom };
}

// 视觉中心 y：底部悬浮详情条展开时，中心取「条上方可用区域」的中点
export function visCenterY(graph: G6TreeGraph): number {
  const { top, bottom } = visibleViewport(graph);
  return (top + bottom) / 2;
}

// 相机基础件：直接合成矩阵 [ratio,0,tx,0,ratio,ty]（模型点钉在指定屏幕位）
// 不经过 G6 的 zoomTo/translate（其内部依赖当前矩阵与 getCanvasBBox，边缘态会写入 NaN）
export function setCameraOnPoint(graph: G6TreeGraph, mx: number, my: number, ratio: number, sp: { x?: number; y?: number }) {
  const W = graph.get('width') || 1;
  const H = graph.get('height') || 1;
  if (!Number.isFinite(ratio) || ratio <= 0) ratio = 1;
  const sx = Number.isFinite(sp && sp.x) ? (sp.x as number) : W / 2;
  const sy = Number.isFinite(sp && sp.y) ? (sp.y as number) : H / 2;
  try {
    // @antv/g mat3 为 [a,b,c, d,e,f, tx,ty,i]：平移在 6/7 位
    graph.get('group').setMatrix([ratio, 0, 0, 0, ratio, 0, sx - ratio * mx, sy - ratio * my, 1]);
    graph.paint();
  } catch (err) { console.warn('[CR-G6] setCameraOnPoint:', err instanceof Error ? err.message : err); }
}

export function setCameraOnNode(graph: G6TreeGraph, nodeId: string, ratio: number, sp: { x?: number; y?: number }) {
  const node = graph.findById(nodeId);
  const m = node && (node.getModel() as unknown as { x?: number; y?: number });
  setCameraOnPoint(graph, m && Number.isFinite(m.x) ? (m.x as number) : 0, m && Number.isFinite(m.y) ? (m.y as number) : 0, ratio, sp);
}

// 通用相机补间：缩放插值到 toZoom；视口中心锚定的模型点滑向 target（target 空=原地缩放，内容不漂移）
export function tweenCameraTo(graph: G6TreeGraph, toZoom: number, target: { x: number; y: number } | null, duration = 380, cx = 0.5, calibrateId?: string) {
  if (graph.__crTween) cancelAnimationFrame(graph.__crTween);
  const W = graph.get('width') || 1;
  const z0 = graph.getZoom();
  const fromZoom = Number.isFinite(z0) && z0 > 0.01 ? z0 : 1;
  if (!Number.isFinite(toZoom) || toZoom <= 0) toZoom = 1;
  // 起始模型点：当前视口中心下的映射（矩阵坏则退回根节点，再退原点）
  let p0: { x: number; y: number } | null = null;
  try {
    const p = graph.getPointByCanvas(W * cx, visCenterY(graph));
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) p0 = { x: p.x, y: p.y };
  } catch { /* 矩阵异常走默认 */ }
  if (!p0) {
    try {
      const root = graph.findById(rootIdOf(graph));
      const m = root && (root.getModel() as unknown as { x?: number; y?: number });
      if (m && Number.isFinite(m.x) && Number.isFinite(m.y)) p0 = { x: m.x as number, y: m.y as number };
    } catch { /* 已销毁 */ }
  }
  if (!p0) p0 = { x: 0, y: 0 };
  const pt = target || p0;
  const anchor = () => ({ x: W * cx, y: visCenterY(graph) });
  const calibrate = () => {
    if (!calibrateId) return;
    setTimeout(() => { try { recenterCamera(graph, calibrateId, cx); } catch { /* 已销毁 */ } }, 80);
  };
  const t0 = performance.now();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    setCameraOnPoint(graph, pt.x, pt.y, toZoom, anchor());   // rAF 冻结兜底：直接终态
    calibrate();
  };
  const timeout = setTimeout(finish, duration + 200);
  const step = () => {
    if (done) return;
    const k = Math.min(1, (performance.now() - t0) / duration);
    const e = 1 - Math.pow(1 - k, 3); // cubicOut
    const ratio = fromZoom + (toZoom - fromZoom) * e;
    const mx = p0.x + (pt.x - p0.x) * e;
    const my = p0.y + (pt.y - p0.y) * e;
    setCameraOnPoint(graph, mx, my, ratio, anchor());
    if (k < 1) graph.__crTween = requestAnimationFrame(step);
    else { clearTimeout(timeout); done = true; graph.__crTween = null; calibrate(); }
  };
  graph.__crTween = requestAnimationFrame(step);
}

// 连续相机（节点版）：目标模型点取节点坐标，结束后以该节点校准
export function tweenCameraToNode(graph: G6TreeGraph, nodeId: string, toZoom: number, duration = 380, cx = 0.5) {
  const node = graph.findById(nodeId);
  const m = node && (node.getModel() as unknown as { x?: number; y?: number });
  if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
  tweenCameraTo(graph, toZoom, { x: m.x as number, y: m.y as number }, duration, cx, nodeId);
}

// 内容包围盒：G6 group.getBBox() 有缓存过期问题（changeData/refreshPositions 后可能只报部分节点），
// 用节点模型坐标手动求并集，缺尺寸的退回 getBBox
function contentBBox(graph: G6TreeGraph): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  graph.getNodes().forEach((n) => {
    const m = n.getModel() as unknown as { x?: number; y?: number; width?: number; height?: number };
    const cx = Number(m.x), cy = Number(m.y);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
    const w = Number(m.width), h = Number(m.height);
    const hw = (Number.isFinite(w) ? w : 90) / 2;
    const hh = (Number.isFinite(h) ? h : 30) / 2;
    minX = Math.min(minX, cx - hw); maxX = Math.max(maxX, cx + hw);
    minY = Math.min(minY, cy - hh); maxY = Math.max(maxY, cy + hh);
  });
  if (minX === Infinity) {
    try {
      const b = graph.get('group').getBBox();
      if (b && Number.isFinite(b.width) && b.width > 0) return b;
    } catch { /* 已销毁 */ }
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// 动画版自适应（工具条「全局」）：按内容盒和真实可视区（底部详情条展开时不含条）算适配缩放，中心滑向内容盒中心
export function animateFitView(graph: G6TreeGraph, padding = 24) {
  try {
    const bbox = contentBBox(graph);
    const W = graph.get('width') || 1;
    const { top, bottom } = visibleViewport(graph);
    const visH = Math.max(80, bottom - top);
    if (bbox && Number.isFinite(bbox.width) && bbox.width > 0 && Number.isFinite(bbox.height) && bbox.height > 0) {
      const fitZoom = Math.min((W - padding * 2) / bbox.width, (visH - padding * 2) / bbox.height);
      if (Number.isFinite(fitZoom) && fitZoom > 0) {
        tweenCameraTo(graph, Math.max(0.05, Math.min(1.5, fitZoom)), { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 }, 380);
        return;
      }
    }
  } catch { /* 已销毁 */ }
  try { graph.fitView(padding); } catch { /* 已销毁 */ }
}

// 动画版回中（工具条「回到中心」）：保持当前缩放，把整棵树（内容盒中心）平移回可视区中心。
// 不钉根节点——LR 树根在内容盒左缘，钉根会让右半棵出画。
export function animateRecenter(graph: G6TreeGraph, duration = 380) {
  try {
    const bbox = contentBBox(graph);
    if (!bbox || !Number.isFinite(bbox.width) || bbox.width <= 0) return;
    const z = graph.getZoom();
    tweenCameraTo(graph, Number.isFinite(z) && z > 0.01 ? z : 1, { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 }, duration);
  } catch { /* 已销毁 */ }
}

// 精确对中：中心节点距视口中心 > 4px 时原地合成居中矩阵（瞬时、不缩放）
export function recenterCamera(graph: G6TreeGraph, nodeId: string, cx = 0.5) {
  try {
    const W = graph.get('width') || 1;
    const target = { x: W * cx, y: visCenterY(graph) };
    const node = graph.findById(nodeId);
    const m = node && (node.getModel() as unknown as { x?: number; y?: number });
    if (!m || !Number.isFinite(m.x)) return;
    const sp = graph.getCanvasByPoint(m.x as number, m.y as number);
    if (!Number.isFinite(sp.x) || !Number.isFinite(sp.y)) return;
    if (Math.abs(sp.x - target.x) < 4 && Math.abs(sp.y - target.y) < 4) return;
    const z = graph.getZoom();
    setCameraOnNode(graph, nodeId, Number.isFinite(z) && z > 0.01 ? z : 1, target);
  } catch { /* 已销毁 */ }
}

// 换树但视觉不断：换前记录目标节点屏幕位，换后补偿平移把它钉回原位 —— 钻取切换零跳动
function pinnedChangeData(graph: G6TreeGraph, datum: FocusDatum, centerId: string) {
  let node = graph.findById(centerId);
  const beforeModel = node && (node.getModel() as unknown as { x?: number; y?: number });
  let before = beforeModel && Number.isFinite(beforeModel.x) && Number.isFinite(graph.getZoom()) && graph.getZoom() > 0
    ? graph.getCanvasByPoint(beforeModel.x as number, beforeModel.y as number)
    : null;
  if (before && !(Number.isFinite(before.x) && Number.isFinite(before.y))) before = null;
  // 连点中节点可能瞬时在画外：钉屏目标出画则改钉视口中心（保证换树后内容可见）
  if (before) {
    const W = graph.get('width') || 1, H = graph.get('height') || 1;
    if (before.x < 0 || before.x > W || before.y < 0 || before.y > H) before = { x: W / 2, y: H / 2 };
  }
  graph.changeData(datum);
  node = graph.findById(centerId);
  const afterModel = node && (node.getModel() as unknown as { x?: number; y?: number });
  // 钉屏：换树后直接把中心节点合成回旧屏幕位（保持当前缩放）
  if (before && afterModel) {
    const z = graph.getZoom();
    setCameraOnNode(graph, centerId, Number.isFinite(z) && z > 0.01 ? z : 1, before);
  }
}

// 钻取/层级切换的相机编排（原型 updateFocusGraphs 的单图版）：
// 动画换树 → 目标缩放（默认推近；内容超画布拉远）→ 单相机 tween → 看门狗自愈
export function updateFocusGraph(graph: G6TreeGraph, datum: FocusDatum, centerId: string) {
  try {
    if (graph.__crTween) { cancelAnimationFrame(graph.__crTween); graph.__crTween = null; }
    // 相机适配必须量换树后的真实尺寸：收起时内容变少要推近，撑满时要拉远。
    // 新树在退场渐隐后才换上，故缩放与补间挪到 afterSettle（布局已定、变形未起）
    animatedChangeData(graph, datum, centerId, {
      autoCenter: false,
      afterSettle: () => {
        const bbox = contentBBox(graph);
        const W = graph.get('width');
        const { top, bottom } = visibleViewport(graph);
        const visH = Math.max(80, bottom - top);
        let toZoom = Math.max(0.85, Math.min(1.1, graph.getZoom() * 1.12));
        if (bbox && Number.isFinite(bbox.width) && bbox.width > 0 && Number.isFinite(bbox.height) && bbox.height > 0) {
          const fitZoom = Math.min((W - 48) / bbox.width, (visH - 40) / bbox.height);
          toZoom = Math.min(toZoom, Math.max(0.45, Math.min(1.15, fitZoom)));
        }
        try {
          tweenCameraToNode(graph, centerId, toZoom, 380);
        } catch (err) {
          console.warn('[CR-G6] tween start:', err instanceof Error ? err.message : err);
          try { graph.fitView(24); } catch { /* 已销毁 */ }
        }
      },
    });
    // 相机自愈看门狗：补间结束后若中心节点不在画布内（或缩放异常），拉回 —— 任何情况下不出白屏
    setTimeout(() => {
      try {
        const node = graph.findById(centerId);
        const m = node && (node.getModel() as unknown as { x?: number; y?: number });
        const zoom = graph.getZoom();
        if (!Number.isFinite(zoom) || zoom <= 0) {
          try { graph.get('group').resetMatrix(); graph.fitView(24); } catch { /* 已销毁 */ }
          return;
        }
        if (!m || !Number.isFinite(m.x)) return;
        if (zoom < 0.2 || zoom > 3) {
          try { graph.fitView(24); } catch { /* 已销毁 */ }
          return;
        }
        const sp = graph.getCanvasByPoint(m.x as number, m.y as number);
        const W2 = graph.get('width') || 1;
        const H2 = graph.get('height') || 1;
        if ((sp.x < 0 || sp.x > W2 || sp.y < 0 || sp.y > H2) && graph.getNodes().length) {
          recenterCamera(graph, centerId);
        }
      } catch { /* 已销毁 */ }
    }, 800);
  } catch (err) { console.warn('[CR-G6] updateFocusGraph:', err instanceof Error ? err.message : err); }
}

// 同中心数据刷新：换树不推近（原型 streaming 换血走原位 update，这里整树换但相机只校准）
export function refreshFocusGraph(graph: G6TreeGraph, datum: FocusDatum, centerId: string) {
  animatedChangeData(graph, datum, centerId);
}

// ============================================================
// 骨架节点（G6 自绘）：灰底胶囊 + 两根灰条，参与布局占位
// shimmer 由全局 rAF loop 驱动
// ============================================================
const liveGraphs = new Set<G6TreeGraph>();

export function registerLiveGraph(graph: G6TreeGraph) {
  liveGraphs.add(graph);
}
export function unregisterLiveGraph(graph: G6TreeGraph) { liveGraphs.delete(graph); }

function registerSkeletonCard() {
  if (!G6 || (G6 as { __crSkeleton?: boolean }).__crSkeleton) return;
  (G6 as { __crSkeleton?: boolean }).__crSkeleton = true;
  // G6 v4 的 ShapeOptions 类型面不含字面 draw 参数，原型即弱类型使用，这里整体断言
  const shape = {
    draw(cfg: { width?: number; height?: number }, group: G6Item) {
      const w = cfg.width || 110;
      const h = cfg.height || 30;
      const rect = group.addShape('rect', {
        attrs: { x: -w / 2, y: -h / 2, width: w, height: h, radius: Math.min(10, h / 2), fill: '#ffffff', stroke: '#e2e8f1', lineWidth: 1.2 },
        name: 'sk-body',
      });
      group.addShape('rect', { attrs: { x: -w / 2 + 10, y: -h / 2 + h / 2 - 5, width: w * 0.62, height: 8, radius: 4, fill: '#e6ebf2' }, name: 'sk-title' });
      group.addShape('rect', { attrs: { x: -w / 2 + w * 0.7, y: -h / 2 + h / 2 - 4, width: w * 0.2, height: 6, radius: 3, fill: '#edf1f6' }, name: 'sk-tail' });
      return rect;
    },
  } as unknown as Parameters<typeof G6.registerNode>[1];
  G6.registerNode('skeleton-card', shape, 'single-node');
}

// 全局 shimmer：单 rAF loop 驱动所有骨架节点透明度脉冲
function paintNow(graph: G6TreeGraph) {
  try { graph.get('canvas').draw(); } catch { try { graph.paint(); } catch { /* 已销毁 */ } }
}

// ============================================================
// 加载占位（骨架树）：与真图同引擎/同布局/同节点骨架，出图零跳变
// ============================================================

interface SkelSpec { id: string; w: number; children?: SkelSpec[] }

const SKELETON_TREE: SkelSpec = {
  id: 'sk-center', w: 132,
  children: [
    { id: 'sk-b1', w: 112, children: [{ id: 'sk-l1', w: 138 }, { id: 'sk-l2', w: 88 }] },
    { id: 'sk-b2', w: 96, children: [{ id: 'sk-l3', w: 120 }, { id: 'sk-l4', w: 82 }] },
  ],
};

function skelDatum(spec: SkelSpec, depth: number): FocusDatum {
  return {
    id: spec.id, label: '', depth, kind: '', width: spec.w, height: depth === 0 ? 36 : 30,
    type: 'skeleton-card', size: [spec.w, depth === 0 ? 36 : 30],
    style: {}, labelCfg: {},
    children: (spec.children || []).map((c) => skelDatum(c, depth + 1)),
  };
}

export function createSkeletonGraph(el: HTMLElement): G6TreeGraph {
  registerSkeletonCard();
  skeletonLoop();
  const graph = new G6.TreeGraph({
    container: el,
    width: el.clientWidth,
    height: el.clientHeight,
    animate: false,
    modes: { default: [] },   // 占位不可交互
    defaultEdge: { type: 'cubic-horizontal', style: { stroke: '#c9d3e0', lineWidth: 1.4 } },
    layout: { type: 'compactBox', direction: 'LR', getId: (d: FocusDatum) => d.id, getHeight: (d: FocusDatum) => d.height || 30, getWidth: (d: FocusDatum) => d.width || 90, getVGap: () => 14, getHGap: () => 40 },
  });
  graph.data(skelDatum(SKELETON_TREE, 0));
  graph.render();
  registerLiveGraph(graph);
  setTimeout(() => { try { frameSkeleton(graph, el); } catch { /* 已销毁 */ } }, 30);
  return graph;
}

// 骨架取景：整体适配画布（超宽才缩），树盒水平居中（root 在盒左缘，补偿半宽）
export function frameSkeleton(graph: G6TreeGraph, el: HTMLElement) {
  const W = el.clientWidth || 1;
  const H = el.clientHeight || 1;
  const bbox = graph.get('group').getBBox();
  if (!bbox || !Number.isFinite(bbox.width) || bbox.width <= 0) return;
  const z = Math.min(1, (W - 48) / bbox.width, (H - 40) / bbox.height);
  setCameraOnNode(graph, rootIdOf(graph), z, { x: (W - bbox.width * z) / 2 + 66 * z, y: H / 2 });
}

let skLoopOn = false;
function skeletonLoop() {
  if (skLoopOn) return;
  skLoopOn = true;
  const step = (t: number) => {
    let any = false;
    liveGraphs.forEach((graph) => {
      try {
        graph.getNodes().forEach((n) => {
          const m = n.getModel() as unknown as { type?: string; x?: number };
          if (m.type !== 'skeleton-card') return;
          any = true;
          const op = 0.6 + 0.25 * Math.sin(t / 320 + (m.x || 0) / 90);
          n.get('group').attr('opacity', op);
        });
      } catch { /* 已销毁 */ }
    });
    if (any) liveGraphs.forEach((graph) => paintNow(graph));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
