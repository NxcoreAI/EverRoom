import { Graph, type IElementEvent, type NodeData } from '@antv/g6';
import { useEffect, useRef } from 'react';

import type { EntityFactGraphData, EntityFactGraphNode } from './entityFactGraphModel';

interface EntityFactGraphCanvasProps {
  data: EntityFactGraphData;
  onSelect: (nodeId: string | null) => void;
  selectedId: string | null;
}

const ENTITY_POSITIONS = [
  [0.5, 0.5],
  [0.25, 0.22],
  [0.75, 0.22],
  [0.2, 0.78],
  [0.8, 0.78],
  [0.5, 0.88],
] as const;

const FACT_POSITIONS = [
  [0.5, 0.18],
  [0.18, 0.5],
  [0.82, 0.5],
  [0.5, 0.65],
] as const;

function nodeKind(datum: NodeData) {
  return datum.data?.kind === 'fact' ? 'fact' : 'entity';
}

function graphLabel(label: string) {
  return label.length > 12 ? `${label.slice(0, 11)}…` : label;
}

function createResizeObserver(callback: ResizeObserverCallback) {
  return typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(callback);
}

function positionedNodes(data: EntityFactGraphData, width: number, height: number) {
  let entityIndex = 0;
  let factIndex = 0;
  return data.nodes.map((node) => {
    const index = node.kind === 'entity' ? entityIndex++ : factIndex++;
    const position =
      node.kind === 'entity'
        ? (ENTITY_POSITIONS[index] ?? ENTITY_POSITIONS[0])
        : (FACT_POSITIONS[index] ?? FACT_POSITIONS[0]);
    return {
      id: node.id,
      data: { kind: node.kind, label: node.label },
      style: { x: position[0] * width, y: position[1] * height },
    };
  });
}

function selectedStates(data: EntityFactGraphData, selectedId: string | null) {
  return Object.fromEntries(
    data.nodes.map((node) => [node.id, node.id === selectedId ? ['selected'] : []])
  );
}

export function EntityFactGraphCanvas({ data, onSelect, selectedId }: EntityFactGraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const dataRef = useRef(data);
  const onSelectRef = useRef(onSelect);
  const selectedIdRef = useRef(selectedId);
  const renderPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const renderRevisionRef = useRef(0);
  const renderedIdsRef = useRef<Set<string>>(new Set());
  dataRef.current = data;
  onSelectRef.current = onSelect;
  selectedIdRef.current = selectedId;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const graph = new Graph({
      animation: false,
      behaviors: ['drag-canvas', 'zoom-canvas'],
      container,
      height: container.clientHeight || 280,
      node: {
        style: {
          cursor: 'pointer',
          fill: '#408cf0',
          labelFill: '#6b7280',
          labelFontSize: (datum: NodeData) => (nodeKind(datum) === 'entity' ? 11 : 10.5),
          labelFontWeight: 500,
          labelMaxWidth: (datum: NodeData) => (nodeKind(datum) === 'entity' ? 82 : 74),
          labelOffsetY: (datum: NodeData) => (nodeKind(datum) === 'entity' ? 6 : 5),
          labelPlacement: 'bottom',
          labelText: (datum: NodeData) =>
            typeof datum.data?.label === 'string' ? graphLabel(datum.data.label) : '',
          labelWordWrap: false,
          lineWidth: 0,
          size: (datum: NodeData) => (nodeKind(datum) === 'entity' ? 24 : 12),
        },
        state: {
          selected: {
            fill: '#408cf0',
            halo: true,
            haloLineWidth: 7,
            haloStroke: '#408cf0',
            haloStrokeOpacity: 0.28,
            labelFill: '#408cf0',
            labelFontWeight: 600,
            lineWidth: 0,
            stroke: '#408cf0',
          },
        },
      },
      edge: {
        style: { lineWidth: 1.2, opacity: 0.9, stroke: '#d1d5db' },
      },
      width: container.clientWidth || 520,
    });
    graphRef.current = graph;
    graph.on('node:click', (event: IElementEvent) => {
      if (event.target.id) onSelectRef.current(event.target.id);
    });
    graph.on('canvas:click', () => onSelectRef.current(null));
    const resizeObserver = createResizeObserver(() => {
      if (container.clientWidth && container.clientHeight) {
        graph.resize(container.clientWidth, container.clientHeight);
        const resizePromise = renderPromiseRef.current
          .then(async () => {
            if (graphRef.current !== graph) return;
            const currentData = dataRef.current;
            graph.updateNodeData(
              positionedNodes(currentData, container.clientWidth, container.clientHeight)
            );
            await graph.draw();
            if (graphRef.current !== graph) return;
            await graph.setElementState(selectedStates(currentData, selectedIdRef.current));
          })
          .catch(() => {
            // A newer Room or graph teardown can supersede resize drawing.
          });
        renderPromiseRef.current = resizePromise;
      }
    });
    resizeObserver?.observe(container);

    return () => {
      resizeObserver?.disconnect();
      renderRevisionRef.current += 1;
      renderedIdsRef.current.clear();
      graphRef.current = null;
      void renderPromiseRef.current.finally(() => graph.destroy());
    };
  }, []);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const revision = renderRevisionRef.current + 1;
    renderRevisionRef.current = revision;
    const ids = new Set(data.nodes.map((node) => node.id));
    const renderPromise = renderPromiseRef.current
      .then(async () => {
        if (graphRef.current !== graph || renderRevisionRef.current !== revision) return;
        graph.setData({
          nodes: positionedNodes(
            data,
            containerRef.current?.clientWidth || 520,
            containerRef.current?.clientHeight || 280
          ),
          edges: data.edges.map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            data: { relation: edge.relation },
          })),
        });
        await graph.render();
        if (graphRef.current !== graph || renderRevisionRef.current !== revision) return;
        renderedIdsRef.current = ids;
        await graph.setElementState(selectedStates(data, selectedIdRef.current));
      })
      .catch(() => {
        // A newer Room or an unmount can supersede an in-flight render.
      });
    renderPromiseRef.current = renderPromise;
  }, [data]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    void renderPromiseRef.current
      .then(async () => {
        if (graphRef.current !== graph) return;
        const states = Object.fromEntries(
          data.nodes
            .filter((node) => renderedIdsRef.current.has(node.id))
            .map((node) => [node.id, node.id === selectedId ? ['selected'] : []])
        );
        if (Object.keys(states).length) await graph.setElementState(states);
      })
      .catch(() => {
        // Selection changes can be invalidated by graph teardown.
      });
  }, [data, selectedId]);

  return (
    <div className="context-room-entity-fact-graph-shell">
      <div
        ref={containerRef}
        aria-label="Room 实体与事实图谱画布"
        className="context-room-entity-fact-graph-canvas"
        role="application"
      />
      <div className="context-room-visually-hidden" aria-label="实体与事实节点">
        {data.nodes.map((node: EntityFactGraphNode) => (
          <button
            type="button"
            key={node.id}
            aria-label={`${node.kind === 'entity' ? '实体' : '事实'}：${node.label}`}
            aria-pressed={selectedId === node.id}
            onClick={() => onSelect(node.id)}
          >
            {node.label}
          </button>
        ))}
      </div>
    </div>
  );
}
