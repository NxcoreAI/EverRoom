import { Graph, type IElementEvent, type NodeData } from '@antv/g6';
import { createElement, forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ContextRoomKind, ContextRoomRecord } from '../types';
import { createRoomGraphData } from './roomGraphModel';
import { roomKindIcon } from './utils';

export interface RoomGraphCanvasHandle {
  fitView(): Promise<void>;
}

interface RoomGraphCanvasProps {
  compact?: boolean;
  rooms: ContextRoomRecord[];
  selectedId: string | null;
  onOpenRoom: (roomId: string) => void;
  onSelectRoom: (roomId: string | null) => void;
}

const ROOM_KIND_COLORS: Record<ContextRoomKind, { fill: string; stroke: string }> = {
  项目: { fill: '#eef3ff', stroke: '#3d6ff6' },
  主题: { fill: '#f2efff', stroke: '#7658d6' },
  人物: { fill: '#e9f7f0', stroke: '#2f8a68' },
  长期目标: { fill: '#fff5e8', stroke: '#c67a25' },
  议题: { fill: '#fff1f0', stroke: '#c95b55' },
  事件: { fill: '#fff3e8', stroke: '#d06b35' },
};

const ROOM_KIND_ICON_SOURCES = Object.fromEntries(
  (Object.keys(ROOM_KIND_COLORS) as ContextRoomKind[]).map((kind) => {
    const Icon = roomKindIcon(kind);
    const svg = renderToStaticMarkup(
      createElement(Icon, {
        'aria-hidden': true,
        color: ROOM_KIND_COLORS[kind].stroke,
        size: 24,
        strokeWidth: 1.8,
      })
    );
    return [kind, `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`];
  })
) as Record<ContextRoomKind, string>;

const ROOM_NODE_POSITIONS = [
  [360, 220],
  [140, 130],
  [590, 120],
  [180, 350],
  [550, 355],
  [360, 70],
  [70, 255],
  [655, 250],
] as const;

function graphElementStates(
  graphData: ReturnType<typeof createRoomGraphData>,
  activeId: string | null,
  activeState: 'hover' | 'selected'
): Record<string, string[]> {
  const states: Record<string, string[]> = {};
  if (!activeId) {
    graphData.nodes.forEach((room) => {
      states[room.id] = [];
    });
    graphData.edges.forEach((edge) => {
      states[edge.id] = [];
    });
    return states;
  }
  const adjacentEdges = graphData.edges.filter(
    (edge) => edge.source === activeId || edge.target === activeId
  );
  const neighbors = new Set(
    adjacentEdges.map((edge) => (edge.source === activeId ? edge.target : edge.source))
  );
  graphData.nodes.forEach((room) => {
    states[room.id] =
      room.id === activeId ? [activeState] : neighbors.has(room.id) ? ['neighbor'] : ['dim'];
  });
  graphData.edges.forEach((edge) => {
    states[edge.id] = adjacentEdges.some((candidate) => candidate.id === edge.id)
      ? ['neighbor']
      : ['dim'];
  });
  return states;
}

function nodeColors(datum: NodeData) {
  return ROOM_KIND_COLORS[nodeKind(datum)];
}

function nodeKind(datum: NodeData): ContextRoomKind {
  const kind = datum.data?.kind;
  return typeof kind === 'string' && kind in ROOM_KIND_COLORS ? (kind as ContextRoomKind) : '主题';
}

function nodeIconSource(datum: NodeData) {
  return ROOM_KIND_ICON_SOURCES[nodeKind(datum)];
}

function createResizeObserver(callback: ResizeObserverCallback) {
  return typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(callback);
}

function RoomGraphCanvasComponent(
  { compact = false, rooms, selectedId, onOpenRoom, onSelectRoom }: RoomGraphCanvasProps,
  ref: React.ForwardedRef<RoomGraphCanvasHandle>
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const renderPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const renderRevisionRef = useRef(0);
  const renderedElementIdsRef = useRef<Set<string>>(new Set());
  const selectedIdRef = useRef(selectedId);
  const onOpenRoomRef = useRef(onOpenRoom);
  const onSelectRoomRef = useRef(onSelectRoom);
  const graphData = useMemo(() => createRoomGraphData(rooms), [rooms]);
  const graphDataRef = useRef(graphData);
  selectedIdRef.current = selectedId;
  onOpenRoomRef.current = onOpenRoom;
  onSelectRoomRef.current = onSelectRoom;
  graphDataRef.current = graphData;

  useImperativeHandle(
    ref,
    () => ({
      fitView: async () => {
        await graphRef.current?.fitView();
      },
    }),
    []
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const graph = new Graph({
      container,
      width: container.clientWidth || 720,
      height: container.clientHeight || 440,
      animation: false,
      node: {
        style: {
          size: compact ? 44 : 58,
          fill: (datum: NodeData) => nodeColors(datum).fill,
          stroke: (datum: NodeData) => nodeColors(datum).stroke,
          lineWidth: 2,
          shadowColor: 'rgba(17, 24, 39, 0.12)',
          shadowBlur: 10,
          icon: true,
          iconSrc: nodeIconSource,
          iconWidth: compact ? 18 : 24,
          iconHeight: compact ? 18 : 24,
          iconPointerEvents: 'none',
          labelText: (datum: NodeData) =>
            typeof datum.data?.label === 'string' ? datum.data.label : '',
          labelFill: '#374151',
          labelFontSize: compact ? 10 : 12,
          labelFontWeight: 500,
          labelPlacement: 'bottom',
          labelOffsetY: 8,
          labelMaxWidth: compact ? 92 : 128,
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
          neighbor: {
            stroke: '#3d6ff6',
            lineWidth: 2.5,
            opacity: 1,
          },
          dim: { opacity: 0.28 },
        },
      },
      edge: {
        style: {
          stroke: '#b9c0ca',
          lineWidth: 1.4,
          opacity: 0.82,
          labelText: (datum: { data?: { relation?: unknown } }) =>
            typeof datum.data?.relation === 'string' ? datum.data.relation : '',
          labelFill: '#7b8491',
          labelFontSize: compact ? 8 : 10,
          labelBackground: true,
          labelBackgroundFill: '#ffffff',
          labelBackgroundOpacity: 0.92,
          labelBackgroundPadding: [2, 4, 2, 4],
        },
        state: {
          neighbor: { stroke: '#3d6ff6', lineWidth: 2, opacity: 1 },
          dim: { opacity: 0.12 },
        },
      },
      behaviors: ['drag-canvas', 'zoom-canvas'],
    });
    graphRef.current = graph;

    const setRenderedElementState = (states: Record<string, string[]>) => {
      const pendingRender = renderPromiseRef.current;
      void pendingRender
        .then(async () => {
          if (graphRef.current !== graph) return;
          const renderedStates = Object.fromEntries(
            Object.entries(states).filter(([id]) => renderedElementIdsRef.current.has(id))
          );
          if (!Object.keys(renderedStates).length) return;
          await graph.setElementState(renderedStates);
        })
        .catch(() => {
          // A pending G6 operation can reject while the graph is being replaced or destroyed.
        });
    };

    graph.on('node:click', (event: IElementEvent) => {
      const roomId = event.target.id;
      if (roomId) onSelectRoomRef.current(roomId);
    });
    graph.on('node:dblclick', (event: IElementEvent) => {
      const roomId = event.target.id;
      if (roomId) onOpenRoomRef.current(roomId);
    });
    graph.on('node:pointerenter', (event: IElementEvent) => {
      const roomId = event.target.id;
      if (roomId)
        setRenderedElementState(graphElementStates(graphDataRef.current, roomId, 'hover'));
    });
    graph.on('node:pointerleave', (event: IElementEvent) => {
      const roomId = event.target.id;
      if (!roomId) return;
      setRenderedElementState(
        graphElementStates(graphDataRef.current, selectedIdRef.current, 'selected')
      );
    });
    graph.on('canvas:click', () => onSelectRoomRef.current(null));

    const resizeObserver = createResizeObserver(() => {
      if (!container.clientWidth || !container.clientHeight) return;
      graph.resize(container.clientWidth, container.clientHeight);
    });
    resizeObserver?.observe(container);

    return () => {
      resizeObserver?.disconnect();
      renderRevisionRef.current += 1;
      renderedElementIdsRef.current.clear();
      graphRef.current = null;
      const pendingRender = renderPromiseRef.current;
      void pendingRender.finally(() => {
        graph.destroy();
      });
    };
  }, [compact]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const revision = renderRevisionRef.current + 1;
    renderRevisionRef.current = revision;
    const elementIds = new Set([
      ...graphData.nodes.map((room) => room.id),
      ...graphData.edges.map((edge) => edge.id),
    ]);
    graph.setData({
      nodes: graphData.nodes.map((room, index) => ({
        id: room.id,
        data: {
          kind: room.kind,
          label: room.title,
          iconSrc: ROOM_KIND_ICON_SOURCES[room.kind],
        },
        style: {
          x:
            (ROOM_NODE_POSITIONS[index]?.[0] ?? 360 + (index - ROOM_NODE_POSITIONS.length) * 70) *
            (compact ? 0.55 : 1),
          y: (ROOM_NODE_POSITIONS[index]?.[1] ?? 220) * (compact ? 0.55 : 1),
        },
      })),
      edges: graphData.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        data: { relation: edge.relation },
      })),
    });
    const renderPromise = graph
      .render()
      .then(async () => {
        if (graphRef.current !== graph || renderRevisionRef.current !== revision) return;
        renderedElementIdsRef.current = elementIds;
        await graph.fitView();
      })
      .catch(() => {
        // Rendering can be interrupted by a compact-mode change or component unmount.
      });
    renderPromiseRef.current = renderPromise;
  }, [compact, graphData]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const pendingRender = renderPromiseRef.current;
    void pendingRender
      .then(async () => {
        if (graphRef.current !== graph) return;
        const states = Object.fromEntries(
          Object.entries(graphElementStates(graphData, selectedId, 'selected')).filter(([id]) =>
            renderedElementIdsRef.current.has(id)
          )
        );
        if (!Object.keys(states).length) return;
        await graph.setElementState(states);
      })
      .catch(() => {
        // Ignore state updates invalidated by a newer render or graph teardown.
      });
  }, [graphData, selectedId]);

  return (
    <div className="context-room-g6-graph-shell">
      <div
        ref={containerRef}
        className="context-room-g6-graph-canvas"
        role="application"
        aria-label="Room 关系图谱画布"
      />
      <div className="context-room-visually-hidden" aria-label="Room 图谱节点">
        {graphData.nodes.map((room) => (
          <button
            type="button"
            key={room.id}
            aria-label={`${room.kind} Room：${room.title}`}
            aria-pressed={selectedId === room.id}
            onClick={() => onSelectRoom(room.id)}
            onDoubleClick={() => onOpenRoom(room.id)}
          >
            查看关系 {room.kind} Room {room.title}
          </button>
        ))}
      </div>
    </div>
  );
}

export const RoomGraphCanvas = forwardRef(RoomGraphCanvasComponent);
