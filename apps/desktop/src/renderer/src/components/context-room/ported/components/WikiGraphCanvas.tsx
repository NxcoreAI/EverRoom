import { Graph, type IElementEvent, type NodeData } from '@antv/g6';
import { BookOpen } from 'lucide-react';
import { createElement, useEffect, useMemo, useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { KnowledgeWikiGraphDto } from '../../../../../../shared/knowledge';

const WIKI_PAGE_ICON_SOURCE = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  renderToStaticMarkup(
    createElement(BookOpen, { 'aria-hidden': true, color: '#3d6ff6', size: 24, strokeWidth: 1.8 })
  )
)}`;

/** 被 2+ 页引用的视为枢纽页（节点放大、着色更重）。 */
function isHub(node: KnowledgeWikiGraphDto['nodes'][number]): boolean {
  return node.inLinks >= 2;
}

function nodeSize(node: KnowledgeWikiGraphDto['nodes'][number]): number {
  return Math.min(56, 36 + node.inLinks * 4);
}

function graphElementStates(
  graph: KnowledgeWikiGraphDto,
  activeId: string | null,
  activeState: 'hover' | 'selected'
): Record<string, string[]> {
  const states: Record<string, string[]> = {};
  if (!activeId) {
    graph.nodes.forEach((node) => { states[node.id] = []; });
    graph.edges.forEach((edge, index) => { states[`edge-${String(index)}`] = []; });
    return states;
  }
  const adjacentEdges = graph.edges
    .map((edge, index) => ({ edge, id: `edge-${String(index)}` }))
    .filter(({ edge }) => edge.source === activeId || edge.target === activeId);
  const neighbors = new Set(
    adjacentEdges.map(({ edge }) => (edge.source === activeId ? edge.target : edge.source))
  );
  graph.nodes.forEach((node) => {
    states[node.id] = node.id === activeId
      ? [activeState]
      : neighbors.has(node.id)
        ? ['neighbor']
        : ['dim'];
  });
  graph.edges.forEach((edge, index) => {
    states[`edge-${String(index)}`] = adjacentEdges.some(({ id }) => id === `edge-${String(index)}`)
      ? ['neighbor']
      : ['dim'];
  });
  return states;
}

/**
 * wiki 内链图谱画布（room-wiki 方案 M3c）：页面=节点、md 内链=边。
 * 力导向布局（d3-force，@antv/layout 内置零插件）：互链页自然聚簇、
 * 疏密随连接展开，替代早期圆环排座（页面一多挤成密环）。
 */
export function WikiGraphCanvas({ graph, selectedPath, onSelectPage }: {
  graph: KnowledgeWikiGraphDto;
  selectedPath: string | null;
  onSelectPage: (path: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const renderPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const renderRevisionRef = useRef(0);
  const renderedElementIdsRef = useRef<Set<string>>(new Set());
  const selectedIdRef = useRef<string | null>(null);
  const onSelectPageRef = useRef(onSelectPage);
  const pathById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node.path])),
    [graph]
  );
  onSelectPageRef.current = onSelectPage;

  const selectedId = selectedPath
    ? graph.nodes.find((node) => node.path === selectedPath)?.id ?? null
    : null;
  selectedIdRef.current = selectedId;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const canvas = new Graph({
      container,
      width: container.clientWidth || 640,
      height: container.clientHeight || 420,
      animation: false,
      layout: {
        type: 'd3-force',
        // 互链聚簇 + 全局摊开：斥力调大防标签叠压，链长给足呼吸感，
        // 弱中心力兜住孤页（无链接的页面不飞出画布）
        linkDistance: 110,
        nodeStrength: -260,
        edgeStrength: 0.35,
        preventOverlap: true,
        collideStrength: 0.7,
        centerStrength: 0.06,
      },
      node: {
        style: {
          fill: (datum: NodeData) => (datum.data?.hub ? '#eef3ff' : '#f3f4f6'),
          stroke: (datum: NodeData) => (datum.data?.hub ? '#3d6ff6' : '#9ca3af'),
          lineWidth: 2,
          size: (datum: NodeData) => (typeof datum.data?.size === 'number' ? datum.data.size : 36),
          icon: true,
          iconSrc: WIKI_PAGE_ICON_SOURCE,
          iconWidth: 16,
          iconHeight: 16,
          iconPointerEvents: 'none',
          labelText: (datum: NodeData) =>
            typeof datum.data?.label === 'string' ? datum.data.label : '',
          labelFill: '#374151',
          labelFontSize: 10,
          labelFontWeight: 500,
          labelPlacement: 'bottom',
          labelOffsetY: 6,
          labelMaxWidth: 96,
          labelWordWrap: true,
          cursor: 'pointer',
        },
        state: {
          selected: {
            stroke: '#3d6ff6',
            lineWidth: 3,
            halo: true,
            haloStroke: '#3d6ff6',
            haloLineWidth: 8,
            haloStrokeOpacity: 0.14,
          },
          hover: {
            stroke: '#3d6ff6',
            lineWidth: 3,
            shadowColor: 'rgba(61, 111, 246, 0.18)',
            shadowBlur: 18,
          },
          neighbor: { stroke: '#3d6ff6', lineWidth: 2.5, opacity: 1 },
          dim: { opacity: 0.28 },
        },
      },
      edge: {
        style: {
          stroke: '#b9c0ca',
          lineWidth: 1.2,
          opacity: 0.8,
        },
        state: {
          neighbor: { stroke: '#3d6ff6', lineWidth: 2, opacity: 1 },
          dim: { opacity: 0.12 },
        },
      },
      behaviors: ['drag-canvas', 'zoom-canvas'],
    });
    graphRef.current = canvas;

    const setRenderedElementState = (states: Record<string, string[]>) => {
      void renderPromiseRef.current
        .then(async () => {
          if (graphRef.current !== canvas) return;
          const renderedStates = Object.fromEntries(
            Object.entries(states).filter(([id]) => renderedElementIdsRef.current.has(id))
          );
          if (!Object.keys(renderedStates).length) return;
          await canvas.setElementState(renderedStates);
        })
        .catch(() => {
          // A pending G6 operation can reject while the graph is being replaced or destroyed.
        });
    };

    canvas.on('node:click', (event: IElementEvent) => {
      const nodeId = event.target.id;
      if (nodeId) onSelectPageRef.current(pathById.get(nodeId) ?? nodeId);
    });
    canvas.on('node:pointerenter', (event: IElementEvent) => {
      const nodeId = event.target.id;
      if (nodeId) setRenderedElementState(graphElementStates(graph, nodeId, 'hover'));
    });
    canvas.on('node:pointerleave', (event: IElementEvent) => {
      if (!event.target.id) return;
      setRenderedElementState(graphElementStates(graph, selectedIdRef.current, 'selected'));
    });

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (!container.clientWidth || !container.clientHeight) return;
          canvas.resize(container.clientWidth, container.clientHeight);
        });
    resizeObserver?.observe(container);

    return () => {
      resizeObserver?.disconnect();
      renderRevisionRef.current += 1;
      renderedElementIdsRef.current.clear();
      graphRef.current = null;
      void renderPromiseRef.current.finally(() => {
        canvas.destroy();
      });
    };
    // Graph instance is created once per mount; data flows in through the render effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = graphRef.current;
    if (!canvas) return;
    const revision = renderRevisionRef.current + 1;
    renderRevisionRef.current = revision;
    const elementIds = new Set([
      ...graph.nodes.map((node) => node.id),
      ...graph.edges.map((_, index) => `edge-${String(index)}`),
    ]);

    // 位置交给 d3-force 布局引擎（互链聚簇、疏密自适应），不再手排圆环
    canvas.setData({
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        data: { label: node.title, hub: isHub(node), size: nodeSize(node) },
      })),
      edges: graph.edges.map((edge, index) => ({
        id: `edge-${String(index)}`,
        source: edge.source,
        target: edge.target,
      })),
    });
    const renderPromise = canvas
      .render()
      .then(async () => {
        if (graphRef.current !== canvas || renderRevisionRef.current !== revision) return;
        renderedElementIdsRef.current = elementIds;
        await canvas.fitView();
      })
      .catch(() => {
        // Rendering can be interrupted by a component unmount or data refresh.
      });
    renderPromiseRef.current = renderPromise;
  }, [graph]);

  useEffect(() => {
    const canvas = graphRef.current;
    if (!canvas) return;
    void renderPromiseRef.current
      .then(async () => {
        if (graphRef.current !== canvas) return;
        const states = Object.fromEntries(
          Object.entries(graphElementStates(graph, selectedId, 'selected')).filter(([id]) =>
            renderedElementIdsRef.current.has(id)
          )
        );
        if (!Object.keys(states).length) return;
        await canvas.setElementState(states);
      })
      .catch(() => {
        // Ignore state updates invalidated by a newer render or graph teardown.
      });
  }, [graph, selectedId]);

  return (
    <div className="context-room-g6-graph-shell context-room-wiki-graph">
      <div
        ref={containerRef}
        className="context-room-g6-graph-canvas"
        role="application"
        aria-label="wiki 页面内链图谱画布"
      />
      <div className="context-room-visually-hidden" aria-label="wiki 图谱节点">
        {graph.nodes.map((node) => (
          <button
            type="button"
            key={node.id}
            aria-label={`wiki 页面：${node.title}（被引 ${String(node.inLinks)} 次）`}
            aria-pressed={node.path === selectedPath}
            onClick={() => onSelectPage(node.path)}
          >
            查看 wiki 页面 {node.title}
          </button>
        ))}
      </div>
    </div>
  );
}
